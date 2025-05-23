import React from "react";
import { Outlet, redirect } from "react-router";
import { Box } from "@mercury-js/mess";
import SideBar from "../../components/sidebar";
import { ThemeProvider } from "../../utils/theme";
import { serverFetch } from "../../utils/action";
import Navbar from "../../components/navbar";
import { parseCookies } from "../../utils/functions";
// import {Route } from "./+types/root";

export async function loader({ request }: any) {
  const cookies = request.headers.get("Cookie");
  const cookieObject = parseCookies(cookies);
  if (cookieObject.userId && cookieObject.role && cookieObject.token) {
    const user = await serverFetch(
      `query Me {
              me {
                id
              }
            }`,
      {},
      {
        cache: "no-store",
        ssr: true,
        cookies: request.headers.get("Cookie"),
      }
    );
    if (user.error) {
      return redirect("/");
    }
  } else return redirect("/");
  const response = await serverFetch(
    `query Docs($where: whereTabInput, $sort: sortTabInput) {
        listTabs(where: $where, sort: $sort) {
          docs {
            id
            label
            order
            icon
            type
            recordId
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
              type
            recordId
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
              type
            recordId
              model {
                id
                label
                name
              }
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
      ssr: true,
      cookies: request.headers.get("Cookie"),
    }
  );
  if (response.error) {
    return response.error; //TODO: handle error
  }
  const sortTabs = (tabs) => {
    if (!tabs) return [];
    return tabs
      .map((tab) => ({
        ...tab,
        childTabs: sortTabs(tab.childTabs),
      }))
      .sort((a, b) => {
        if (a.order === b.order) {
          return (a.label || "").localeCompare(b.label || "");
        }
        return a.order - b.order;
      });
  };

  const sortedTabs = sortTabs(response.listTabs?.docs);

  return sortedTabs;
}
const dashboard = ({ loaderData }: { loaderData: any }) => {
  return (
    <div>
      {/* <ThemeProvider> */}
      <Navbar />
      <Box styles={{ base: { display: "flex", flexDirection: "row" } }}>
        <SideBar tabs={loaderData} />
        <Box
          styles={{
            base: {
              width: "calc(100vw - 240px)",
              height: "calc(100vh - 56px)",
              padding: 20,
              overflow: "auto",
              background: "#F8F8F8",
            },
          }}
        >
          <Outlet />
        </Box>
      </Box>
      {/* </ThemeProvider> */}
    </div>
  );
};

export default dashboard;
