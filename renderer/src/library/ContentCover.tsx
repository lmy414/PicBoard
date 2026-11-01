import { useEffect, useRef, useState } from "react";
import type { ContentRecord } from "../../../shared/image-board";
import { parseAssetRef } from "../content/content-meta";
import { KindIcon } from "../ui/ContentIcons";
import "./cover.css";

/**
 * Thumbnail for a content card: an image content's own file or a rich-text
 * cover asset. Falls back to the kind glyph when the thumbnail cannot load.
 */
export function contentCoverSource(content: ContentRecord): string | null {
  if (content.kind === "image" && content.image) {
    return window.imageBoard.imageUrl(content.id, "thumb");
  }
  const ref = parseAssetRef(content.coverAsset);
  return ref ? window.imageBoard.assetUrl(ref.contentId, ref.assetId, "thumb") : null;
}

export function ContentCover({ content, className }: { content: ContentRecord; className?: string }) {
  const source = contentCoverSource(content);
  const [status, setStatus] = useState<{ source: string; state: "loading" | "loaded" | "failed" }>({
    source: source ?? "",
    state: "loading",
  });
  const imageRef = useRef<HTMLImageElement>(null);
  const state = status.source === source ? status.state : "loading";

  useEffect(() => {
    if (!source) return;
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) setStatus({ source, state: "loaded" });
  }, [source]);

  if (!source) return null;

  return (
    <span className={`content-cover is-${state}${className ? ` ${className}` : ""}`}>
      <span className="content-cover-shimmer" aria-hidden="true" />
      <img
        key={source}
        ref={imageRef}
        src={source}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => setStatus({ source, state: "loaded" })}
        onError={() => setStatus({ source, state: "failed" })}
      />
      {state === "failed" ? (
        <span className="content-cover-fallback" aria-hidden="true">
          <KindIcon kind={content.kind} size={15} />
        </span>
      ) : null}
    </span>
  );
}
