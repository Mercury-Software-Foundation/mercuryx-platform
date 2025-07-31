import React from 'react'
import { serverFetch } from '../utils/action';
import DynamicComponentLoader from './DynamicComponentLoader';
import { MESS_TAGS } from '../utils/constant';
import { useLazyQuery } from '../utils/hook';

const RenderComponet = ({
  componentName,
  props,
}: {
  componentName: string;
  props: any;
}) => {
const [componentData, setComponentData] = React.useState<any>(null);

React.useEffect(() => {
    const fetchData = async () => {
        const data = await serverFetch(
            `query GetComponent($where: whereComponentInput!) {
                getComponent(where: $where) {
                    id
                    name
                    label
                    code
                }
            }`,
            {
                where: {
                    name: {
                        is: componentName,
                    },
                },
            },
            { cache: "no-store", ssr: true }
        );
        setComponentData(data);
    };

    fetchData();
}, [componentName]);

  const code = componentData?.getComponent?.code;
  console.log(componentData, "component data for", componentName, code);
  if (!code) {
    console.error("Component code not found for:", componentName);
    return (
      <>
        Component not found
      </>
    );
  }
  return (
    <React.Suspense fallback={<div>Loading...</div>}>
      <DynamicComponentLoader
        props={{
          ...props,
          Std: {
            ...MESS_TAGS,
            data: {},
            serverFetch: serverFetch,
            useLazyQuery: useLazyQuery,
            RenderComponent: this,
          },
        }}
        code={code}
      />
    </React.Suspense>
  );
};

export default RenderComponet;