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
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.2 13.6l1.3 1-.9 1.6-1.6-.4a7 7 0 0 1-1.7 1l-.3 1.7h-1.9l-.3-1.7a7 7 0 0 1-1.7-1l-1.6.4-.9-1.6 1.3-1a7 7 0 0 1 0-2l-1.3-1 .9-1.6 1.6.4a7 7 0 0 1 1.7-1l.3-1.7h1.9l.3 1.7a7 7 0 0 1 1.7 1l1.6-.4.9 1.6-1.3 1a7 7 0 0 1 0 2z" />
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

export function IconMinus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12h14" />
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
