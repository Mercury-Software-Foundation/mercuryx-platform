import React, { useEffect, useState } from "react";
import { serverFetch } from "../../utils/action";
import { useLazyQuery } from "../../utils/hook";
import {
  GET_DYNAMIC_MODEL_LIST,
  getModelFieldRefModelKey,
} from "../../utils/functions";
import { Box, Option } from "@mercury-js/mess";
import { UseFormReturn } from "react-hook-form";

const GenerateRelationshipValues = ({
  fieldData,
  form,
}: {
  fieldData: any;
  form: UseFormReturn;
}) => {
  const [listRecords, { data, loading, error }] = useLazyQuery(serverFetch);
  const [listModelFields, listModelFieldsResponse] = useLazyQuery(serverFetch);
  const [refKey, setRefKey] = useState("");

  useEffect(() => {
    (async () => {
      const key = await getModelFieldRefModelKey(fieldData.ref);
      setRefKey(key);
    })();
    listModelFields(
      `query ListModelFields($where: whereModelFieldInput, $limit: Int!) {
    listModelFields(where: $where, limit: $limit) {
      docs {
        id
        name
        enumValues
ref
        label
        managed
        required
        enumType
        ref
        many
        unique
        type
        model {
          id
          name
          label
          recordKey {
            id
            name
            label
          }
          
        }

      }
      limit
    }
  }`,
      {
        where: {
          modelName: {
            is: fieldData.ref,
          },
          name: {
            notContains: "password",
          },
        },
        limit: 200,
      },
      {}
    );
  }, []);
  useEffect(() => {
    if (listModelFieldsResponse.data) {
      GET_DYNAMIC_MODEL_LIST(
        fieldData.ref,
        listModelFieldsResponse?.data?.listModelFields?.docs
      ).then((str) => {
        listRecords(
          str,
          {
            sort: {
              createdOn: "desc",
            },
            limit: 1000,
            offset: 0,
          },
          {}
        );
      });
    }
  }, [
    listModelFieldsResponse.data,
    listModelFieldsResponse.error,
    listModelFieldsResponse.loading,
  ]);

  useEffect(()=>{
    if(data){
      form.trigger(fieldData.name)
    }
  }, [data])

  return (
    <>
      {data?.[`list${fieldData.ref}s`]?.docs.map((item: any) => {
        return (
          <Option
            key={item?.id}
            value={item.id}
            title={JSON.stringify(item, null, 4)}
          >
            {refKey ? item[refKey] : item.id}
          </Option>
        );
      })}
    </>
  );
};

export default GenerateRelationshipValues;
