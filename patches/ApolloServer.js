import { isNodeLike } from '@apollo/utils.isnodelike';
import { InMemoryLRUCache, PrefixingKeyValueCache, } from '@apollo/utils.keyvaluecache';
import { makeExecutableSchema } from '@graphql-tools/schema';
import resolvable from './utils/resolvable.js';
import { GraphQLError, assertValidSchema, print, printSchema, } from 'graphql';
import loglevel from 'loglevel';
import Negotiator from 'negotiator';
import { newCachePolicy } from './cachePolicy.js';
import { determineApolloConfig } from './determineApolloConfig.js';
import { ensureError, ensureGraphQLError, normalizeAndFormatErrors, } from './errorNormalize.js';
import { ApolloServerErrorCode, ApolloServerValidationErrorCode, } from './errors/index.js';
import { runPotentiallyBatchedHttpQuery } from './httpBatching.js';
import { pluginIsInternal } from './internalPlugin.js';
import { preventCsrf, recommendedCsrfPreventionRequestHeaders, } from './preventCsrf.js';
import { APQ_CACHE_PREFIX, processGraphQLRequest } from './requestPipeline.js';
import { newHTTPGraphQLHead, prettyJSONStringify } from './runHttpQuery.js';
import { HeaderMap } from './utils/HeaderMap.js';
import { UnreachableCaseError } from './utils/UnreachableCaseError.js';
import { computeCoreSchemaHash } from './utils/computeCoreSchemaHash.js';
import { isDefined } from './utils/isDefined.js';
import { SchemaManager } from './utils/schemaManager.js';
const NoIntrospection = (context) => ({
    Field(node) {
        if (node.name.value === '__schema' || node.name.value === '__type') {
            context.reportError(new GraphQLError('GraphQL introspection is not allowed by Apollo Server, but the query contained __schema or __type. To enable introspection, pass introspection: true to ApolloServer in production', {
                nodes: [node],
                extensions: {
                    validationErrorCode: ApolloServerValidationErrorCode.INTROSPECTION_DISABLED,
                },
            }));
        }
    },
});
function defaultLogger() {
    const loglevelLogger = loglevel.getLogger('apollo-server');
    loglevelLogger.setLevel(loglevel.levels.INFO);
    return loglevelLogger;
}
export class ApolloServer {
    constructor(config) {
        const nodeEnv = config.nodeEnv ?? process.env.NODE_ENV ?? '';
        this.logger = config.logger ?? defaultLogger();
        const apolloConfig = determineApolloConfig(config.apollo, this.logger);
        const isDev = nodeEnv !== 'production';
        if (config.cache &&
            config.cache !== 'bounded' &&
            PrefixingKeyValueCache.prefixesAreUnnecessaryForIsolation(config.cache)) {
            throw new Error('You cannot pass a cache returned from ' +
                '`PrefixingKeyValueCache.cacheDangerouslyDoesNotNeedPrefixesForIsolation`' +
                'to `new ApolloServer({ cache })`, because Apollo Server may use it for ' +
                'multiple features whose cache keys must be distinct from each other.');
        }
        const state = config.gateway
            ?
                {
                    phase: 'initialized',
                    schemaManager: new SchemaManager({
                        gateway: config.gateway,
                        apolloConfig,
                        schemaDerivedDataProvider: (schema) => ApolloServer.generateSchemaDerivedData(schema, config.documentStore),
                        logger: this.logger,
                    }),
                }
            :
                {
                    phase: 'initialized',
                    schemaManager: new SchemaManager({
                        apiSchema: ApolloServer.constructSchema(config),
                        schemaDerivedDataProvider: (schema) => ApolloServer.generateSchemaDerivedData(schema, config.documentStore),
                        logger: this.logger,
                    }),
                };
        const introspectionEnabled = config.introspection ?? isDev;
        const hideSchemaDetailsFromClientErrors = config.hideSchemaDetailsFromClientErrors ?? false;
        this.cache =
            config.cache === undefined || config.cache === 'bounded'
                ? new InMemoryLRUCache()
                : config.cache;
        this.internals = {
            formatError: config.formatError,
            rootValue: config.rootValue,
            validationRules: [
                ...(config.validationRules ?? []),
                ...(introspectionEnabled ? [] : [NoIntrospection]),
            ],
            hideSchemaDetailsFromClientErrors,
            dangerouslyDisableValidation: config.dangerouslyDisableValidation ?? false,
            fieldResolver: config.fieldResolver,
            includeStacktraceInErrorResponses: config.includeStacktraceInErrorResponses ??
                (nodeEnv !== 'production' && nodeEnv !== 'test'),
            persistedQueries: config.persistedQueries === false
                ? undefined
                : {
                    ...config.persistedQueries,
                    cache: new PrefixingKeyValueCache(config.persistedQueries?.cache ?? this.cache, APQ_CACHE_PREFIX),
                },
            nodeEnv,
            allowBatchedHttpRequests: config.allowBatchedHttpRequests ?? false,
            apolloConfig,
            plugins: config.plugins ?? [],
            parseOptions: config.parseOptions ?? {},
            state,
            stopOnTerminationSignals: config.stopOnTerminationSignals,
            gatewayExecutor: null,
            csrfPreventionRequestHeaders: config.csrfPrevention === true || config.csrfPrevention === undefined
                ? recommendedCsrfPreventionRequestHeaders
                : config.csrfPrevention === false
                    ? null
                    : (config.csrfPrevention.requestHeaders ??
                        recommendedCsrfPreventionRequestHeaders),
            status400ForVariableCoercionErrors: config.status400ForVariableCoercionErrors ?? false,
            __testing_incrementalExecutionResults: config.__testing_incrementalExecutionResults,
            stringifyResult: config.stringifyResult ?? prettyJSONStringify,
        };
    }
    async start() {
        return await this._start(false);
    }

    async restart(config) {
        this.internals.state = {
            phase: 'initialized',
            schemaManager: new SchemaManager({
                apiSchema: ApolloServer.constructSchema(config),
                schemaDerivedDataProvider: (schema) =>
                    ApolloServer.generateSchemaDerivedData(
                        schema,
                        null,
                    ),
                logger: this.logger,
            }),
        };
        await this._start(false);
    }

    startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests() {
        this._start(true).catch((e) => this.logStartupError(e));
    }
    async _start(startedInBackground) {
        if (this.internals.state.phase !== 'initialized') {
            throw new Error(`You should only call 'start()' or ` +
                `'startInBackgroundHandlingStartupErrorsByLoggingAndFailingAllRequests()' ` +
                `once on your ApolloServer.`);
        }
        const schemaManager = this.internals.state.schemaManager;
        const barrier = resolvable();
        this.internals.state = {
            phase: 'starting',
            barrier,
            schemaManager,
            startedInBackground,
        };
        try {
            await this.addDefaultPlugins();
            const toDispose = [];
            const executor = await schemaManager.start();
            if (executor) {
                this.internals.gatewayExecutor = executor;
            }
            toDispose.push(async () => {
                await schemaManager.stop();
            });
            const schemaDerivedData = schemaManager.getSchemaDerivedData();
            const service = {
                logger: this.logger,
                cache: this.cache,
                schema: schemaDerivedData.schema,
                apollo: this.internals.apolloConfig,
                startedInBackground,
            };
            const taggedServerListeners = (await Promise.all(this.internals.plugins.map(async (plugin) => ({
                serverListener: plugin.serverWillStart && (await plugin.serverWillStart(service)),
                installedImplicitly: isImplicitlyInstallablePlugin(plugin) &&
                    plugin.__internal_installed_implicitly__,
            })))).filter((maybeTaggedServerListener) => typeof maybeTaggedServerListener.serverListener === 'object');
            taggedServerListeners.forEach(({ serverListener: { schemaDidLoadOrUpdate } }) => {
                if (schemaDidLoadOrUpdate) {
                    schemaManager.onSchemaLoadOrUpdate(schemaDidLoadOrUpdate);
                }
            });
            const serverWillStops = taggedServerListeners
                .map((l) => l.serverListener.serverWillStop)
                .filter(isDefined);
            if (serverWillStops.length) {
                toDispose.push(async () => {
                    await Promise.all(serverWillStops.map((serverWillStop) => serverWillStop()));
                });
            }
            const drainServerCallbacks = taggedServerListeners
                .map((l) => l.serverListener.drainServer)
                .filter(isDefined);
            const drainServers = drainServerCallbacks.length
                ? async () => {
                    await Promise.all(drainServerCallbacks.map((drainServer) => drainServer()));
                }
                : null;
            let taggedServerListenersWithRenderLandingPage = taggedServerListeners.filter((l) => l.serverListener.renderLandingPage);
            if (taggedServerListenersWithRenderLandingPage.length > 1) {
                taggedServerListenersWithRenderLandingPage =
                    taggedServerListenersWithRenderLandingPage.filter((l) => !l.installedImplicitly);
            }
            let landingPage = null;
            if (taggedServerListenersWithRenderLandingPage.length > 1) {
                throw Error('Only one plugin can implement renderLandingPage.');
            }
            else if (taggedServerListenersWithRenderLandingPage.length) {
                landingPage =
                    await taggedServerListenersWithRenderLandingPage[0].serverListener
                        .renderLandingPage();
            }
            const toDisposeLast = this.maybeRegisterTerminationSignalHandlers(['SIGINT', 'SIGTERM'], startedInBackground);
            this.internals.state = {
                phase: 'started',
                schemaManager,
                drainServers,
                landingPage,
                toDispose,
                toDisposeLast,
            };
        }
        catch (maybeError) {
            const error = ensureError(maybeError);
            try {
                await Promise.all(this.internals.plugins.map(async (plugin) => plugin.startupDidFail?.({ error })));
            }
            catch (pluginError) {
                this.logger.error(`startupDidFail hook threw: ${pluginError}`);
            }
            this.internals.state = {
                phase: 'failed to start',
                error,
            };
            throw error;
        }
        finally {
            barrier.resolve();
        }
    }
    maybeRegisterTerminationSignalHandlers(signals, startedInBackground) {
        const toDisposeLast = [];
        if (this.internals.stopOnTerminationSignals === false ||
            (this.internals.stopOnTerminationSignals === undefined &&
                !(isNodeLike &&
                    this.internals.nodeEnv !== 'test' &&
                    !startedInBackground))) {
            return toDisposeLast;
        }
        let receivedSignal = false;
        const signalHandler = async (signal) => {
            if (receivedSignal) {
                return;
            }
            receivedSignal = true;
            try {
                await this.stop();
            }
            catch (e) {
                this.logger.error(`stop() threw during ${signal} shutdown`);
                this.logger.error(e);
                process.exit(1);
            }
            process.kill(process.pid, signal);
        };
        signals.forEach((signal) => {
            process.on(signal, signalHandler);
            toDisposeLast.push(async () => {
                process.removeListener(signal, signalHandler);
            });
        });
        return toDisposeLast;
    }
    async _ensureStarted() {
        while (true) {
            switch (this.internals.state.phase) {
                case 'initialized':
                    throw new Error('You need to call `server.start()` before using your Apollo Server.');
                case 'starting':
                    await this.internals.state.barrier;
                    break;
                case 'failed to start':
                    this.logStartupError(this.internals.state.error);
                    throw new Error('This data graph is missing a valid configuration. More details may be available in the server logs.');
                case 'started':
                case 'draining':
                    return this.internals.state;
                case 'stopping':
                case 'stopped':
                    this.logger.warn('A GraphQL operation was received during server shutdown. The ' +
                        'operation will fail. Consider draining the HTTP server on shutdown; ' +
                        'see https://go.apollo.dev/s/drain for details.');
                    throw new Error(`Cannot execute GraphQL operations ${this.internals.state.phase === 'stopping'
                        ? 'while the server is stopping'
                        : 'after the server has stopped'}.'`);
                default:
                    throw new UnreachableCaseError(this.internals.state);
            }
        }
    }
    assertStarted(expressionForError) {
        if (this.internals.state.phase !== 'started' &&
            this.internals.state.phase !== 'draining' &&
            !(this.internals.state.phase === 'starting' &&
                this.internals.state.startedInBackground)) {
            throw new Error('You must `await server.start()` before calling `' +
                expressionForError +
                '`');
        }
    }
    logStartupError(err) {
        this.logger.error('An error occurred during Apollo Server startup. All GraphQL requests ' +
            'will now fail. The startup error was: ' +
            (err?.message || err));
    }
    static constructSchema(config) {
        if (config.schema) {
            return config.schema;
        }
        const { typeDefs, resolvers } = config;
        const augmentedTypeDefs = Array.isArray(typeDefs) ? typeDefs : [typeDefs];
        return makeExecutableSchema({
            typeDefs: augmentedTypeDefs,
            resolvers,
        });
    }
    static generateSchemaDerivedData(schema, providedDocumentStore) {
        assertValidSchema(schema);
        return {
            schema,
            documentStore: providedDocumentStore === undefined
                ? new InMemoryLRUCache()
                : providedDocumentStore,
            documentStoreKeyPrefix: providedDocumentStore
                ? `${computeCoreSchemaHash(printSchema(schema))}:`
                : '',
        };
    }
    async stop() {
        switch (this.internals.state.phase) {
            case 'initialized':
            case 'starting':
            case 'failed to start':
                throw Error('apolloServer.stop() should only be called after `await apolloServer.start()` has succeeded');
            case 'stopped':
                if (this.internals.state.stopError) {
                    throw this.internals.state.stopError;
                }
                return;
            case 'stopping':
            case 'draining': {
                await this.internals.state.barrier;
                const state = this.internals.state;
                if (state.phase !== 'stopped') {
                    throw Error(`Surprising post-stopping state ${state.phase}`);
                }
                if (state.stopError) {
                    throw state.stopError;
                }
                return;
            }
            case 'started':
                break;
            default:
                throw new UnreachableCaseError(this.internals.state);
        }
        const barrier = resolvable();
        const { schemaManager, drainServers, landingPage, toDispose, toDisposeLast, } = this.internals.state;
        this.internals.state = {
            phase: 'draining',
            barrier,
            schemaManager,
            landingPage,
        };
        try {
            await drainServers?.();
            this.internals.state = { phase: 'stopping', barrier };
            await Promise.all([...toDispose].map((dispose) => dispose()));
            await Promise.all([...toDisposeLast].map((dispose) => dispose()));
        }
        catch (stopError) {
            this.internals.state = {
                phase: 'stopped',
                stopError: stopError,
            };
            barrier.resolve();
            throw stopError;
        }
        this.internals.state = { phase: 'stopped', stopError: null };
    }
    async addDefaultPlugins() {
        const { plugins, apolloConfig, nodeEnv, hideSchemaDetailsFromClientErrors, } = this.internals;
        const isDev = nodeEnv !== 'production';
        const alreadyHavePluginWithInternalId = (id) => plugins.some((p) => pluginIsInternal(p) && p.__internal_plugin_id__ === id);
        const pluginsByInternalID = new Map();
        for (const p of plugins) {
            if (pluginIsInternal(p)) {
                const id = p.__internal_plugin_id__;
                if (!pluginsByInternalID.has(id)) {
                    pluginsByInternalID.set(id, {
                        sawDisabled: false,
                        sawNonDisabled: false,
                    });
                }
                const seen = pluginsByInternalID.get(id);
                if (p.__is_disabled_plugin__) {
                    seen.sawDisabled = true;
                }
                else {
                    seen.sawNonDisabled = true;
                }
                if (seen.sawDisabled && seen.sawNonDisabled) {
                    throw new Error(`You have tried to install both ApolloServerPlugin${id} and ` +
                        `ApolloServerPlugin${id}Disabled in your server. Please choose ` +
                        `whether or not you want to disable the feature and install the ` +
                        `appropriate plugin for your use case.`);
                }
            }
        }
        {
            if (!alreadyHavePluginWithInternalId('CacheControl')) {
                const { ApolloServerPluginCacheControl } = await import('./plugin/cacheControl/index.js');
                plugins.push(ApolloServerPluginCacheControl());
            }
        }
        {
            const alreadyHavePlugin = alreadyHavePluginWithInternalId('UsageReporting');
            if (!alreadyHavePlugin && apolloConfig.key) {
                if (apolloConfig.graphRef) {
                    const { ApolloServerPluginUsageReporting } = await import('./plugin/usageReporting/index.js');
                    plugins.unshift(ApolloServerPluginUsageReporting({
                        __onlyIfSchemaIsNotSubgraph: true,
                    }));
                }
                else {
                    this.logger.warn('You have specified an Apollo key but have not specified a graph ref; usage ' +
                        'reporting is disabled. To enable usage reporting, set the `APOLLO_GRAPH_REF` ' +
                        'environment variable to `your-graph-id@your-graph-variant`. To disable this ' +
                        'warning, install `ApolloServerPluginUsageReportingDisabled`.');
                }
            }
        }
        {
            const alreadyHavePlugin = alreadyHavePluginWithInternalId('SchemaReporting');
            const enabledViaEnvVar = process.env.APOLLO_SCHEMA_REPORTING === 'true';
            if (!alreadyHavePlugin && enabledViaEnvVar) {
                if (apolloConfig.key) {
                    const { ApolloServerPluginSchemaReporting } = await import('./plugin/schemaReporting/index.js');
                    plugins.push(ApolloServerPluginSchemaReporting());
                }
                else {
                    throw new Error("You've enabled schema reporting by setting the APOLLO_SCHEMA_REPORTING " +
                        'environment variable to true, but you also need to provide your ' +
                        'Apollo API key, via the APOLLO_KEY environment ' +
                        'variable or via `new ApolloServer({apollo: {key})');
                }
            }
        }
        {
            const alreadyHavePlugin = alreadyHavePluginWithInternalId('InlineTrace');
            if (!alreadyHavePlugin) {
                const { ApolloServerPluginInlineTrace } = await import('./plugin/inlineTrace/index.js');
                plugins.push(ApolloServerPluginInlineTrace({ __onlyIfSchemaIsSubgraph: true }));
            }
        }
        const alreadyHavePlugin = alreadyHavePluginWithInternalId('LandingPageDisabled');
        if (!alreadyHavePlugin) {
            const { ApolloServerPluginLandingPageLocalDefault, ApolloServerPluginLandingPageProductionDefault, } = await import('./plugin/landingPage/default/index.js');
            const plugin = isDev
                ? ApolloServerPluginLandingPageLocalDefault()
                : ApolloServerPluginLandingPageProductionDefault();
            if (!isImplicitlyInstallablePlugin(plugin)) {
                throw Error('default landing page plugin should be implicitly installable?');
            }
            plugin.__internal_installed_implicitly__ = true;
            plugins.push(plugin);
        }
        {
            const alreadyHavePlugin = alreadyHavePluginWithInternalId('DisableSuggestions');
            if (hideSchemaDetailsFromClientErrors && !alreadyHavePlugin) {
                const { ApolloServerPluginDisableSuggestions } = await import('./plugin/disableSuggestions/index.js');
                plugins.push(ApolloServerPluginDisableSuggestions());
            }
        }
    }
    addPlugin(plugin) {
        if (this.internals.state.phase !== 'initialized') {
            throw new Error("Can't add plugins after the server has started");
        }
        this.internals.plugins.push(plugin);
    }
    async executeHTTPGraphQLRequest({ httpGraphQLRequest, context, }) {
        try {
            let runningServerState;
            try {
                runningServerState = await this._ensureStarted();
            }
            catch (error) {
                return await this.errorResponse(error, httpGraphQLRequest);
            }
            if (runningServerState.landingPage &&
                this.prefersHTML(httpGraphQLRequest)) {
                let renderedHtml;
                if (typeof runningServerState.landingPage.html === 'string') {
                    renderedHtml = runningServerState.landingPage.html;
                }
                else {
                    try {
                        renderedHtml = await runningServerState.landingPage.html();
                    }
                    catch (maybeError) {
                        const error = ensureError(maybeError);
                        this.logger.error(`Landing page \`html\` function threw: ${error}`);
                        return await this.errorResponse(error, httpGraphQLRequest);
                    }
                }
                return {
                    headers: new HeaderMap([['content-type', 'text/html']]),
                    body: {
                        kind: 'complete',
                        string: renderedHtml,
                    },
                };
            }
            if (this.internals.csrfPreventionRequestHeaders) {
                preventCsrf(httpGraphQLRequest.headers, this.internals.csrfPreventionRequestHeaders);
            }
            let contextValue;
            try {
                contextValue = await context();
            }
            catch (maybeError) {
                const error = ensureError(maybeError);
                try {
                    await Promise.all(this.internals.plugins.map(async (plugin) => plugin.contextCreationDidFail?.({
                        error,
                    })));
                }
                catch (pluginError) {
                    this.logger.error(`contextCreationDidFail hook threw: ${pluginError}`);
                }
                return await this.errorResponse(ensureGraphQLError(error, 'Context creation failed: '), httpGraphQLRequest);
            }
            return await runPotentiallyBatchedHttpQuery(this, httpGraphQLRequest, contextValue, runningServerState.schemaManager.getSchemaDerivedData(), this.internals);
        }
        catch (maybeError_) {
            const maybeError = maybeError_;
            if (maybeError instanceof GraphQLError &&
                maybeError.extensions.code === ApolloServerErrorCode.BAD_REQUEST) {
                try {
                    await Promise.all(this.internals.plugins.map(async (plugin) => plugin.invalidRequestWasReceived?.({ error: maybeError })));
                }
                catch (pluginError) {
                    this.logger.error(`invalidRequestWasReceived hook threw: ${pluginError}`);
                }
            }
            return await this.errorResponse(maybeError, httpGraphQLRequest);
        }
    }
    async errorResponse(error, requestHead) {
        const { formattedErrors, httpFromErrors } = normalizeAndFormatErrors([error], {
            includeStacktraceInErrorResponses: this.internals.includeStacktraceInErrorResponses,
            formatError: this.internals.formatError,
        });
        return {
            status: httpFromErrors.status ?? 500,
            headers: new HeaderMap([
                ...httpFromErrors.headers,
                [
                    'content-type',
                    chooseContentTypeForSingleResultResponse(requestHead) ??
                        MEDIA_TYPES.APPLICATION_JSON,
                ],
            ]),
            body: {
                kind: 'complete',
                string: await this.internals.stringifyResult({
                    errors: formattedErrors,
                }),
            },
        };
    }
    prefersHTML(request) {
        const acceptHeader = request.headers.get('accept');
        return (request.method === 'GET' &&
            !!acceptHeader &&
            new Negotiator({
                headers: { accept: acceptHeader },
            }).mediaType([
                MEDIA_TYPES.APPLICATION_JSON,
                MEDIA_TYPES.APPLICATION_GRAPHQL_RESPONSE_JSON,
                MEDIA_TYPES.MULTIPART_MIXED_EXPERIMENTAL,
                MEDIA_TYPES.MULTIPART_MIXED_NO_DEFER_SPEC,
                MEDIA_TYPES.TEXT_HTML,
            ]) === MEDIA_TYPES.TEXT_HTML);
    }
    async executeOperation(request, options = {}) {
        if (this.internals.state.phase === 'initialized') {
            await this.start();
        }
        const schemaDerivedData = (await this._ensureStarted()).schemaManager.getSchemaDerivedData();
        const graphQLRequest = {
            ...request,
            query: request.query && typeof request.query !== 'string'
                ? print(request.query)
                : request.query,
        };
        const response = await internalExecuteOperation({
            server: this,
            graphQLRequest,
            internals: this.internals,
            schemaDerivedData,
            sharedResponseHTTPGraphQLHead: null,
        }, options);
        return response;
    }
}
export async function internalExecuteOperation({ server, graphQLRequest, internals, schemaDerivedData, sharedResponseHTTPGraphQLHead, }, options) {
    const requestContext = {
        logger: server.logger,
        cache: server.cache,
        schema: schemaDerivedData.schema,
        request: graphQLRequest,
        response: {
            http: sharedResponseHTTPGraphQLHead ?? newHTTPGraphQLHead(),
        },
        contextValue: cloneObject(options?.contextValue ?? {}),
        metrics: {},
        overallCachePolicy: newCachePolicy(),
        requestIsBatched: sharedResponseHTTPGraphQLHead !== null,
    };
    try {
        return await processGraphQLRequest(schemaDerivedData, server, internals, requestContext);
    }
    catch (maybeError) {
        const error = ensureError(maybeError);
        await Promise.all(internals.plugins.map(async (plugin) => plugin.unexpectedErrorProcessingRequest?.({
            requestContext,
            error,
        })));
        server.logger.error(`Unexpected error processing request: ${error}`);
        throw new Error('Internal server error');
    }
}
export function isImplicitlyInstallablePlugin(p) {
    return '__internal_installed_implicitly__' in p;
}
export const MEDIA_TYPES = {
    APPLICATION_JSON: 'application/json; charset=utf-8',
    APPLICATION_JSON_GRAPHQL_CALLBACK: 'application/json; callbackSpec=1.0; charset=utf-8',
    APPLICATION_GRAPHQL_RESPONSE_JSON: 'application/graphql-response+json; charset=utf-8',
    MULTIPART_MIXED_NO_DEFER_SPEC: 'multipart/mixed',
    MULTIPART_MIXED_EXPERIMENTAL: 'multipart/mixed; deferSpec=20220824',
    TEXT_HTML: 'text/html',
};
export function chooseContentTypeForSingleResultResponse(head) {
    const acceptHeader = head.headers.get('accept');
    if (!acceptHeader) {
        return MEDIA_TYPES.APPLICATION_JSON;
    }
    else {
        const preferred = new Negotiator({
            headers: { accept: head.headers.get('accept') },
        }).mediaType([
            MEDIA_TYPES.APPLICATION_JSON,
            MEDIA_TYPES.APPLICATION_GRAPHQL_RESPONSE_JSON,
            MEDIA_TYPES.APPLICATION_JSON_GRAPHQL_CALLBACK,
        ]);
        if (preferred) {
            return preferred;
        }
        else {
            return null;
        }
    }
}
function cloneObject(object) {
    return Object.assign(Object.create(Object.getPrototypeOf(object)), object);
}
//# sourceMappingURL=ApolloServer.js.map
// patched by mercury