import React from "react";
import DynamicForm from "../components/dynamicForm";
import DynamicTableContainer from "../container/dynamicTableContainer";
import { serverFetch } from "../utils/action";
import { GET_VIEW, LIST_VIEW } from "../utils/query";
import {
  GET_DYNAMIC_MODEL_LIST,
  getModelFieldRefModelKey,
  getSearchCompostion,
  parseCookies,
} from "../utils/functions";
import { A, Box } from "@mercury-js/mess";
import { ChevronsUpDown } from "lucide-react";
import { CustomeInput } from "../components/inputs";
import _ from "lodash";
import DynamicTable from "../components/table";

export async function loader({
  params,
  request,
}: {
  params: { model: string };
  request: any;
}) {
  const cookies = request.headers.get("Cookie");
  const cookieObject = parseCookies(cookies);
  const profileResponse = await serverFetch(
    `query Docs($where: whereProfileInput) {
  listProfiles(where: $where) {
    docs {
      id
      name
    }
  }
}`,
    {
      where: {
        name: {
          is: cookieObject.role,
        },
      },
    },
    {
      cache: "no-store",
      ssr: true,
      cookies: request.headers.get("Cookie"),
    }
  );
  if (profileResponse.error) {
    return profileResponse.error;
  }
  const response = await serverFetch(
    GET_VIEW,
    {
      where: {
        modelName: {
          is: params?.model,
        },
      },
    },
    {
      cache: "no-store",
      ssr: true,
      cookies: request.headers.get("Cookie"),
    }
  );
  if (response.error) {
    return response.error; //TODO: handle error
  }

  const response1 = await serverFetch(
    LIST_VIEW,
    {
      sort: {
        order: "asc",
      },
      limit: 10000,
      where: {
        view: {
          is: response?.getView?.id,
        },
        visible: true,
      },
    },
    {
      cache: "no-store",
      ssr: true,
      cookies: request.headers.get("Cookie"),
    }
  );
  const refKeyMap: Record<string, string> = {};

  for (const field of response1?.listViewFields?.docs || []) {
    if (field.field.type === "relationship" || field.field.type === "virtual") {
      refKeyMap[field.field.name] = await getModelFieldRefModelKey(
        field.field.ref,
        request.headers.get("Cookie")
      );
    }
  }
  const str = await GET_DYNAMIC_MODEL_LIST(
    params?.model as string,
    response1?.listViewFields?.docs.map((doc: any) => doc.field),
    request.headers.get("Cookie")
  );
  const modelData = await serverFetch(
    str,
    {
      sort: {
        createdOn: "desc",
      },
      limit: 10,
      offset: 0,
    },
    {
      cache: "no-store",
      ssr: true,
      cookies: request.headers.get("Cookie"),
    }
  );
  const searchComposition = getSearchCompostion(
    response1?.listViewFields?.docs.map((doc: any) => doc.field),
    ""
  );

  return {
    view: response?.getView,
    dynamicQueryString: str,
    modelData: modelData?.[`list${params?.model}s`]?.docs,
    totalDocs: modelData?.[`list${params?.model}s`]?.totalDocs,
    modelName: params?.model,
    viewFields: response1?.listViewFields,
    refKeyMap,
    searchVariables: searchComposition,
    buttons: response?.getView?.buttons?.filter((btn: any) =>
      btn.profiles
        .map((item: any) => item?.id)
        .includes(profileResponse?.listProfiles?.docs[0]?.id)
    ),
  };
}

const dashboard = ({
  loaderData,
}: {
  loaderData: {
    view: any;
    dynamicQueryString: string;
    modelData: any;
    totalDocs: number;
    modelName: string;
    viewFields: any;
    refKeyMap: any;
    searchVaraiables: any;
    buttons: any[];
  };
}) => {
  return (
    <Box
      styles={{
        base: {
          padding: 10,
        },
        lg: {
          padding: 0,
        },
      }}
    >
      {loaderData?.viewFields?.totalDocs && (
        <DynamicTableContainer
          viewFields={loaderData?.viewFields}
          dynamicQueryString={loaderData?.dynamicQueryString}
          modelData={loaderData?.modelData}
          modelName={loaderData?.modelName}
          totalDocs={loaderData?.totalDocs}
          viewId={loaderData.view?.id}
          refKeyMap={loaderData?.refKeyMap}
          buttons={loaderData?.buttons}
          searchVaraiables={loaderData?.searchVaraiables}
        />
      )}
    </Box>
  );
};

export default dashboard;
