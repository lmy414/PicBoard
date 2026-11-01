import type { ReactNode, SVGProps } from "react";

/**
 * Shared inline SVG icon set for the UI lane (contract: `ui/Icons.tsx`).
 * Stroke-based, 24×24 viewBox, currentColor, round caps — no platform glyphs.
 */

export type IconProps = SVGProps<SVGSVGElement> & { size?: number };

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

export function IconCheck(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4.6 12.8l4.4 4.4L19.4 7" />
    </Icon>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  );
}

export function IconGear(props: IconProps) {
  // The outline was drawn around (15.05, 12.6); re-center and scale it so the
  // gear optically matches the 3.5–20.5 span of the surrounding line icons.
  // The group stroke is divided by the group scale so the rendered weight stays
  // identical to the other 1.8-stroke icons.
  return (
    <Icon {...props}>
      <g transform="translate(12 12) scale(1.42) translate(-15.05 -12.6)" strokeWidth={1.8 / 1.42}>
        <circle cx="15.05" cy="12.6" r="3.1" />
        <path d="M19.2 13.6l1.3 1-.9 1.6-1.6-.4a7 7 0 0 1-1.7 1l-.3 1.7h-1.9l-.3-1.7a7 7 0 0 1-1.7-1l-1.6.4-.9-1.6 1.3-1a7 7 0 0 1 0-2l-1.3-1 .9-1.6 1.6.4a7 7 0 0 1 1.7-1l.3-1.7h1.9l.3 1.7a7 7 0 0 1 1.7 1l1.6-.4.9 1.6-1.3 1a7 7 0 0 1 0 2z" />
      </g>
    </Icon>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 9.5l6 6 6-6" />
    </Icon>
  );
}

export function IconDots(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5" cy="12" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="0.6" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function IconMagnet(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 3.6v7.9a5 5 0 0 0 10 0V3.6" />
      <path d="M7 8h3.8M13.2 8H17" />
    </Icon>
  );
}

export function IconMinus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12h14" />
    </Icon>
  );
}

export function IconPanelLeft(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="M9 4.5v15" />
    </Icon>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function IconFolder(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 6.5h6l2 2.2h9a1.5 1.5 0 0 1 1.5 1.5v7.8a1.5 1.5 0 0 1-1.5 1.5h-17a1.5 1.5 0 0 1-1.5-1.5V8a1.5 1.5 0 0 1 1.5-1.5z" />
    </Icon>
  );
}

export function IconInfo(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.2" />
      <circle cx="12" cy="7.8" r="0.4" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function IconAlertTriangle(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10.2 4.9L2.9 17.4a1.6 1.6 0 0 0 1.4 2.4h15.4a1.6 1.6 0 0 0 1.4-2.4L13.8 4.9a1.7 1.7 0 0 0-3.6 0z" />
      <path d="M12 9.6v4.4" />
      <circle cx="12" cy="16.9" r="0.5" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M15.8 15.8L20 20" />
    </Icon>
  );
}

export function IconPage(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 3.5h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z" />
      <path d="M14 3.5V8h4" />
    </Icon>
  );
}

export function IconGrid(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.2" />
    </Icon>
  );
}
