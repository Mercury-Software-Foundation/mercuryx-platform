import React from "react";
import { Outlet } from "react-router";
import { Box } from "@mercury-js/mess";
import SideBar from "../../components/sidebar";
import { ThemeProvider } from "../../utils/theme";
import { serverFetch } from "../../utils/action";
import Navbar from "../../components/navbar";

export async function loader() {
  const response = await serverFetch(
    `query Docs($where: whereTabInput, $sort: sortTabInput) {
        listTabs(where: $where, sort: $sort) {
          docs {
            id
            label
            order
            icon
            model {
                id
                label
                name
              }
            childTabs {
              id
              icon
              label
              order
              model {
                id
                label
                name
              }
            }
            profiles {
              id
              label
              name

            }
          }
        }
      }`,
    {
      where: {
        parent: {
          is: null,
        },
      },
      sort: {
        order: "asc",
      },
    },
    {
      cache: "no-store",
    }
  );
  if (response.error) {
    return response.error; //TODO: handle error
  }
  let sortedTabs = response.listTabs?.docs.sort((a, b) => a.order - b.order);

  sortedTabs = sortedTabs?.map((tab) => ({
    ...tab,
    childTabs: tab.childTabs.sort((a, b) => a.order - b.order),
  }));

  return sortedTabs;
}
const dashboard = ({ loaderData }: { loaderData: any }) => {
  return (
    <div>
      <ThemeProvider>
        <Navbar />
        <Box styles={{ base: { display: "flex", flexDirection: "row" } }}>
          {loaderData?.length && <SideBar tabs={loaderData} />}
          <Box
            styles={{
              base: {
                width: "calc(100vw - 280px)",

                padding: 20,
              },
            }}
          >
            <Outlet />
          </Box>
        </Box>
      </ThemeProvider>
    </div>
  );
};

export default dashboard;
