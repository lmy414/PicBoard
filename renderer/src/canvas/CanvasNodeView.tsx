import { memo, useEffect, useState } from "react";
import type { CanvasNode, ContentRecord } from "../../../shared/image-board";
import { KIND_LABEL, contentTitle, linkDomain } from "../content/content-meta";
import { KindIcon } from "../ui/ContentIcons";

/** Which mid-side dot started a relation drag. */
export type EdgeSide = "top" | "right" | "bottom" | "left";

export interface CanvasNodeViewProps {
  node: CanvasNode;
  content: ContentRecord;
  selected: boolean;
  onPointerDown: (event: React.PointerEvent<HTMLElement>, node: CanvasNode) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>, node: CanvasNode) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>, node: CanvasNode) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>, node: CanvasNode) => void;
  onConnectStart: (event: React.PointerEvent<HTMLElement>, node: CanvasNode, side: EdgeSide) => void;
  onOpen: (node: CanvasNode, origin: HTMLElement) => void;
  onToggleSelect: (nodeId: string) => void;
  onQuickActions: (event: React.MouseEvent<HTMLElement> | null, node: CanvasNode) => void;
  onElement: (nodeId: string, element: HTMLElement | null) => void;
}

const SIDES: EdgeSide[] = ["top", "right", "bottom", "left"];

function NodeBody({ content, coverAssetId }: { content: ContentRecord; coverAssetId: string | null }) {
  const [imageFailed, setImageFailed] = useState(false);
  const [coverFailed, setCoverFailed] = useState(false);
  const [coverLoaded, setCoverLoaded] = useState(false);
  useEffect(() => {
    setImageFailed(false);
    setCoverFailed(false);
    setCoverLoaded(false);
  }, [content.id, content.coverAsset]);

  if (content.kind === "image") {
    const name = content.image?.fileName ?? content.preview;
    return (
      <>
        {imageFailed || !content.image
          ? <div className="node-image-missing">预览不可用</div>
          : <img
            className="node-image-pixels"
            src={window.imageBoard.imageUrl(content.id, "thumb")}
            alt={name}
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setImageFailed(true)}
          />}
        <span className="node-image-name">{name}</span>
      </>
    );
  }

  if (content.kind === "link") {
    return (
      <>
        <div className="node-head"><KindIcon kind={content.kind} size={13} /><span>{KIND_LABEL[content.kind]}</span></div>
        <strong className="node-link-domain">{content.url ? linkDomain(content.url) : "链接"}</strong>
        <span className="node-link-url">{content.url ?? content.preview}</span>
      </>
    );
  }

  const body = (
    <>
      <div className="node-head"><KindIcon kind={content.kind} size={13} /><span>{KIND_LABEL[content.kind]}</span></div>
      <div className="node-text-body">{content.preview || "空白内容"}</div>
    </>
  );

  if (!coverAssetId) return body;

  return (
    <>
      <div className="node-cover" aria-hidden="true">
        {coverFailed
          ? <div className="node-cover-missing" />
          : <img
            className={`node-cover-image${coverLoaded ? " loaded" : ""}`}
            src={window.imageBoard.assetUrl(content.id, coverAssetId, "thumb")}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onLoad={() => setCoverLoaded(true)}
            onError={() => setCoverFailed(true)}
          />}
      </div>
      <div className="node-text-inner">{body}</div>
    </>
  );
}

/** One content placement on a canvas, rendered at the host-computed node size. */
export const CanvasNodeView = memo(function CanvasNodeView(props: CanvasNodeViewProps) {
  const { node, content, selected, onElement } = props;
  const label = `${KIND_LABEL[content.kind]}：${contentTitle(content)}`;
  const coverAsset = content.kind === "richText" ? content.coverAsset : null;
  const coverSeparator = coverAsset ? coverAsset.indexOf("/") : -1;
  const coverAssetId = coverAsset && coverSeparator > 0 && coverSeparator < coverAsset.length - 1
    ? coverAsset.slice(coverSeparator + 1)
    : null;

  return (
    <article
      ref={(element) => onElement(node.id, element)}
      role="button"
      tabIndex={0}
      data-node-id={node.id}
      aria-label={label}
      aria-pressed={selected}
      className={`canvas-node node-${content.kind}${coverAssetId ? " node-with-cover" : ""}${selected ? " selected" : ""}`}
      style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
      onPointerDown={(event) => props.onPointerDown(event, node)}
      onPointerMove={(event) => props.onPointerMove(event, node)}
      onPointerUp={(event) => props.onPointerUp(event, node)}
      onPointerCancel={(event) => props.onPointerCancel(event, node)}
      onLostPointerCapture={(event) => props.onPointerCancel(event, node)}
      onDoubleClick={(event) => { event.stopPropagation(); props.onOpen(node, event.currentTarget); }}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); props.onQuickActions(event, node); }}
      onKeyDown={(event) => {
        if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
          event.preventDefault();
          props.onQuickActions(null, node);
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          if (event.shiftKey) props.onToggleSelect(node.id);
          else props.onOpen(node, event.currentTarget);
        }
      }}
    >
      <NodeBody content={content} coverAssetId={coverAssetId} />
      {SIDES.map((side) => (
        <span
          key={side}
          className={`node-handle handle-${side}`}
          aria-hidden="true"
          title="拖拽到另一个节点建立连线"
          onPointerDown={(event) => props.onConnectStart(event, node, side)}
        />
      ))}
    </article>
  );
});
