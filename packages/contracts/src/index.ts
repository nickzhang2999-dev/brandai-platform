export * from "./enums";
export * from "./entities";
export * from "./ai";
export * from "./api";
export * from "./admin";
export * from "./rule-snapshot";
export * from "./collab";
export * from "./async-task";
export * from "./queue";
export * from "./notifications";
export * from "./quota-policy";
export * from "./release-policy";
export * from "./generation-defaults";
export * from "./generation-size";
export * from "./resource-usage";
// VI strong-typed modules (P1.1). Namespace-exported to avoid colliding with
// existing top-level names; consumers do `import { VI } from "@brandai/contracts"`.
export * as VI from "./vi/index";
export * from "./canvas";
export * from "./layer-set";
export * from "./editor-document";
export * from "./workbench-session";
export * from "./native-project";
export * from "./workbench-shell";
export * from "./studio-materials";
export * from "./studio-workflow";

export * from "./studio-generation";
export * from "./studio-compliance";
export * from "./studio-edit";
