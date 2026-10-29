/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

declare module "lucide-react/dist/esm/icons/*" {
  import type { LucideIcon } from "lucide-react";
  const icon: LucideIcon;
  export default icon;
}
