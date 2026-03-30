/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

declare module "lucide-react/dist/esm/icons/*" {
  import type { LucideIcon } from "lucide-react";
  const icon: LucideIcon;
  export default icon;
}

declare module "refractor/lib/core" {
  export { refractor } from "refractor";
}

declare module "refractor/lang/*" {
  import type { Syntax } from "refractor/lib/core";
  const syntax: Syntax;
  export default syntax;
}
