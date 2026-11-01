import React from "react";
import ReactDOM from "react-dom/client";
import type { ImageBoardApi } from "../../shared/image-board";
import OrbDemo from "./OrbDemo";

// BloubBall can use the same pointer tracking in a plain browser. The desktop
// cursor publisher is absent here, so provide only its optional subscription.
window.imageBoard = { onCursorPosition: () => () => {} } as unknown as ImageBoardApi;

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("找不到小球 Demo 挂载节点");

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <OrbDemo />
  </React.StrictMode>,
);
