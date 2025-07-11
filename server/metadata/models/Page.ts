import mercury from "@mercury-js/core";

export const page = mercury.createModel(
  "Page",
  {
    name: {
      type: "string",
      required: true,
    },
    description: {
      type: "string",
    },
    slug: {
      type: "string",
      required: true,
      unique: true,
      pattern: "^[a-z0-9\\-]+$",
    },
    protected: {
        type: "boolean",
        default: true
    },
    component: {
      type: "relationship",
      ref: "Component",
      required: true,
    },
    isPublished: {
      type: "boolean",
      default: false,
    },
    metaTitle: {
      type: "string",
    },
    metaDescription: {
      type: "string",
    },
    metaKeywords: {
      type: "string",
      many: true,
    },
    isProtected: {
      type: "boolean",
      default: true,
    },
    profiles: {
        type: "relationship",
        ref: "Profile",
        many: true,
        default: [],
    }
  },
  {
    historyTracking: true,
  }
);
