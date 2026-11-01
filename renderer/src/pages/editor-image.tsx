import { useEffect, useRef, useState } from "react";
import type { NodeViewProps } from "@tiptap/react";
import { NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import Image from "@tiptap/extension-image";
import { KindIcon } from "../ui/ContentIcons";
import { parseAssetRef } from "../content/content-meta";

/** Normalize an HTML dimension attribute or node attr to a positive integer. */
function dimension(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function ContentImageView({ node, selected }: NodeViewProps) {
  const asset = typeof node.attrs.asset === "string" ? node.attrs.asset : "";
  const ref = parseAssetRef(asset);
  const width = dimension(node.attrs.width);
  const height = dimension(node.attrs.height);
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const src = ref ? window.imageBoard.assetUrl(ref.contentId, ref.assetId, "full") : "";
  const broken = failed || !src;

  useEffect(() => {
    setLoaded(false);
    setFailed(false);
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) setLoaded(true);
  }, [asset, src]);

  return (
    <NodeViewWrapper
      className={`cp-rt-image${selected ? " is-selected" : ""}${loaded ? " is-loaded" : ""}`}
      data-drag-handle
      data-asset={asset || undefined}
    >
      <div
        className={`cp-rt-image-frame${broken ? " is-broken" : ""}`}
        style={{
          aspectRatio: width && height ? `${width} / ${height}` : "16 / 10",
          width: width ? `min(100%, ${width}px)` : "100%",
        }}
      >
        <span
          className="cp-rt-image-placeholder"
          style={{ opacity: loaded || broken ? 0 : 1 }}
          aria-hidden="true"
        />
        {broken ? (
          <span className="cp-rt-image-error">
            <KindIcon kind="image" size={16} />
            图片无法显示
          </span>
        ) : (
          <img
            ref={imageRef}
            className="cp-rt-image-img"
            src={src}
            alt={alt}
            draggable={false}
            decoding="async"
            onLoad={() => setLoaded(true)}
            onError={() => {
              setFailed(true);
              setLoaded(false);
            }}
          />
        )}
      </div>
    </NodeViewWrapper>
  );
}

/**
 * Block image for rich text. Only stored `data-asset` references parse; remote
 * URLs, file paths and inline data URIs are dropped by the schema. The rendered
 * src points at the host asset protocol and exists only for display.
 */
export const ContentImage = Image.extend({
  name: "image",

  addAttributes() {
    return {
      asset: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-asset"),
        renderHTML: (attributes) => (attributes.asset ? { "data-asset": String(attributes.asset) } : {}),
      },
      alt: {
        default: null,
        parseHTML: (element) => element.getAttribute("alt"),
        renderHTML: (attributes) => (attributes.alt ? { alt: String(attributes.alt) } : {}),
      },
      width: {
        default: null,
        parseHTML: (element) => dimension(element.getAttribute("width")),
        renderHTML: (attributes) => (dimension(attributes.width) ? { width: String(dimension(attributes.width)) } : {}),
      },
      height: {
        default: null,
        parseHTML: (element) => dimension(element.getAttribute("height")),
        renderHTML: (attributes) => (dimension(attributes.height) ? { height: String(dimension(attributes.height)) } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "img[data-asset]" }];
  },

  renderHTML({ node }) {
    const asset = typeof node.attrs.asset === "string" ? node.attrs.asset : "";
    const ref = parseAssetRef(asset);
    const width = dimension(node.attrs.width);
    const height = dimension(node.attrs.height);
    const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
    const attributes: Record<string, string> = {};
    if (asset) attributes["data-asset"] = asset;
    if (alt) attributes.alt = alt;
    if (width) attributes.width = String(width);
    if (height) attributes.height = String(height);
    if (ref) attributes.src = window.imageBoard.assetUrl(ref.contentId, ref.assetId, "full");
    return ["img", attributes];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ContentImageView);
  },

  addInputRules() {
    return [];
  },
});
