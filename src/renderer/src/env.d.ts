import type { BeeApi } from "../../preload";

declare global {
  interface Window {
    bee: BeeApi;
  }
}
