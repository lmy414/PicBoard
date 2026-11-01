import type { ReactNode, SVGProps } from "react";
import type { ContentKind } from "../../../shared/image-board";

/**
 * Content-surface icon set. Same conventions as `ui/Icons.tsx`: inline SVG,
 * 24×24 viewBox, currentColor strokes, round caps, 1.8 stroke width.
 */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={rest.className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

function TextKindGlyph({ size }: { size: number }) {
  return (
    <Icon size={size}>
      <path d="M4.5 6.5h15M4.5 12h15M4.5 17.5h9" />
    </Icon>
  );
}

function RichTextKindGlyph({ size }: { size: number }) {
  return (
    <Icon size={size}>
      <path d="M5 5.5h3.2M6.6 5.5v8M4.6 13.5h4" />
      <path d="M11.5 6.5H20M11.5 10.5H20M11.5 14.5H16.5" />
      <path d="M4.5 17.5h15" />
    </Icon>
  );
}

function LinkKindGlyph({ size }: { size: number }) {
  return (
    <Icon size={size}>
      <path d="M10.2 13.8a4 4 0 0 0 5.7 0l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.4 1.4" />
      <path d="M13.8 10.2a4 4 0 0 0-5.7 0l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.4-1.4" />
    </Icon>
  );
}

function ImageKindGlyph({ size }: { size: number }) {
  return (
    <Icon size={size}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.4" />
      <circle cx="8.6" cy="9.4" r="1.5" />
      <path d="M4.5 17l4.6-4.6 3.1 3.1 2.6-2.6 4.7 4.7" />
    </Icon>
  );
}

/** Kind glyph used by chips, cards, list rows and page headers. */
export function KindIcon({ kind, size = 16 }: { kind: ContentKind; size?: number }) {
  switch (kind) {
    case "text":
      return <TextKindGlyph size={size} />;
    case "richText":
      return <RichTextKindGlyph size={size} />;
    case "link":
      return <LinkKindGlyph size={size} />;
    case "image":
      return <ImageKindGlyph size={size} />;
  }
}

export function IconArrowLeft(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M19 12H5" />
      <path d="M11 6l-6 6 6 6" />
    </Icon>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2.2" />
      <path d="M15.5 8.5V6.7A2.2 2.2 0 0 0 13.3 4.5H6.7a2.2 2.2 0 0 0-2.2 2.2v6.6a2.2 2.2 0 0 0 2.2 2.2h1.8" />
    </Icon>
  );
}

export function IconExternalLink(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.5 5.5H18.5V10.5" />
      <path d="M18.2 5.8L10.5 13.5" />
      <path d="M18.5 14.2v3.1a2.2 2.2 0 0 1-2.2 2.2H6.7a2.2 2.2 0 0 1-2.2-2.2V7.7a2.2 2.2 0 0 1 2.2-2.2h3.1" />
    </Icon>
  );
}

export function IconEdit(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.2 5.4l5.4 5.4" />
      <path d="M15.9 2.7l5.4 5.4-11 11H4.9v-5.4z" />
    </Icon>
  );
}

export function IconTag(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 5.2a1 1 0 0 1 1-1h5.6l8.7 8.7a1.4 1.4 0 0 1 0 2l-4.9 4.9a1.4 1.4 0 0 1-2 0L4.5 11V5.2z" />
      <circle cx="8.4" cy="8.3" r="1.15" />
    </Icon>
  );
}

export function IconCanvas(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.4" />
      <path d="M9 4.5v15M9 11.5h11.5" />
    </Icon>
  );
}

export function IconZoomIn(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="M15.6 15.6l4.2 4.2M8.2 10.8h5.2M10.8 8.2v5.2" />
    </Icon>
  );
}

export function IconZoomOut(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="M15.6 15.6l4.2 4.2M8.2 10.8h5.2" />
    </Icon>
  );
}

export function IconFit(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.5 9V5.5a1 1 0 0 1 1-1H9" />
      <path d="M15 4.5h3.5a1 1 0 0 1 1 1V9" />
      <path d="M19.5 15v3.5a1 1 0 0 1-1 1H15" />
      <path d="M9 19.5H5.5a1 1 0 0 1-1-1V15" />
      <rect x="8.5" y="8.5" width="7" height="7" rx="1" />
    </Icon>
  );
}

export function IconParagraph(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13 4.5H7.8a4.2 4.2 0 0 0 0 8.4H11" />
      <path d="M11 4.5v15M15.8 4.5v15" />
    </Icon>
  );
}

export function IconBulletList(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5.2" cy="6.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="5.2" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="5.2" cy="17.5" r="1.1" fill="currentColor" stroke="none" />
      <path d="M9.2 6.5h10.3M9.2 12h10.3M9.2 17.5h10.3" />
    </Icon>
  );
}

export function IconOrderedList(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.6 5.2h1.6v4M3.5 9.2h3.2" />
      <path d="M3.5 14.1a1.6 1.6 0 0 1 3.1.5c0 1.1-3.1 2.1-3.1 3.4h3.2" />
      <path d="M10 6.5h10M10 12h10M10 17.5h10" />
    </Icon>
  );
}

export function IconToDo(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="4.5" width="7" height="7" rx="1.8" />
      <path d="M5.3 8l1.7 1.7L9 6.7" />
      <rect x="3.5" y="14" width="7" height="7" rx="1.8" />
      <path d="M13.5 8h6.8M13.5 17.5h6.8" />
    </Icon>
  );
}

export function IconQuote(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.6 6.4c-2.4.8-4 2.5-4 5.2V17h5v-5H7.4c0-1.7.8-2.9 2.6-3.5z" />
      <path d="M18.6 6.4c-2.4.8-4 2.5-4 5.2V17h5v-5h-3.2c0-1.7.8-2.9 2.6-3.5z" />
    </Icon>
  );
}

export function IconCode(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8.4 7.2L3.8 12l4.6 4.8M15.6 7.2L20.2 12l-4.6 4.8" />
    </Icon>
  );
}

export function IconTable(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
      <path d="M3.5 9.5h17M3.5 14.5h17M9.6 9.5v10M14.8 9.5v10" />
    </Icon>
  );
}

export function IconClipboard(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5" y="4.5" width="14" height="16" rx="2.2" />
      <path d="M9 4.5V3.8a1.3 1.3 0 0 1 1.3-1.3h3.4A1.3 1.3 0 0 1 15 3.8v.7" />
      <path d="M8.5 10h7M8.5 13.5h7M8.5 17h4" />
    </Icon>
  );
}
