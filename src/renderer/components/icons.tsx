/**
 * Inline SVG icon components. All icons inherit `currentColor` and use
 * `stroke-width: 1.5` for a refined linework look.
 *
 * Keep new icons here — do NOT import an icon package. Bundle stays lean.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function baseProps(size: number): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  };
}

export function IconLogo({ size = 22, ...rest }: IconProps): JSX.Element {
  // Geometric e-frank mark: a stacked rotated square + accent dot.
  return (
    <svg {...baseProps(size)} {...rest} viewBox="0 0 24 24" fill="none">
      <rect
        x="4"
        y="4"
        width="13"
        height="13"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect
        x="9"
        y="9"
        width="11"
        height="11"
        rx="2.5"
        fill="currentColor"
        fillOpacity="0.18"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}

export function IconProjects({ size = 18, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(size)} {...rest}>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h4l2 2h7A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" />
    </svg>
  );
}

export function IconKey({ size = 18, ...rest }: IconProps): JSX.Element {
  // Stylized key — bow + bit, drawn in the same stroke style as IconProjects/
  // IconSettings. Used for the Connections nav row.
  return (
    <svg {...baseProps(size)} {...rest}>
      <circle cx="8" cy="14" r="3.5" />
      <path d="m11 12 8-8" />
      <path d="m15 8 3 3" />
      <path d="m17 6 2 2" />
    </svg>
  );
}

export function IconSettings({ size = 18, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(size)} {...rest}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function IconGitHub({ size = 18, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(size)} {...rest} fill="currentColor" stroke="none">
      <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.53 2.34 1.09 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.56-1.11-4.56-4.95 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.56 9.56 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.6 1.03 2.69 0 3.85-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z" />
    </svg>
  );
}

export function IconBitbucket({ size = 18, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(size)} {...rest} fill="currentColor" stroke="none">
      <path d="M3.5 4 5 19.2c.06.46.45.8.92.8h12.16c.47 0 .86-.34.92-.8L20.5 4zm10.93 10.65h-4.83l-.74-3.93h6.32z" />
    </svg>
  );
}

export function IconJira({ size = 18, ...rest }: IconProps): JSX.Element {
  // Stylized Jira-ish chevron stack
  return (
    <svg {...baseProps(size)} {...rest}>
      <path d="M11.4 2.6 21 12l-9.6 9.4-2.1-2.1L17 12 9.3 4.7z" fill="currentColor" stroke="none" opacity="0.85" />
      <path d="M5.4 8.6 9.6 12 5.4 16l-2-2 2.2-2-2.2-2z" fill="currentColor" stroke="none" opacity="0.5" />
    </svg>
  );
}

export function IconArrowRight({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(size)} {...rest}>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

export function IconArrowLeft({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(size)} {...rest}>
      <path d="M19 12H5" />
      <path d="m11 18-6-6 6-6" />
    </svg>
  );
}

export function IconPlus({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(size)} {...rest}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

export function IconCheck({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(size)} {...rest}>
      <path d="m5 12 5 5L20 7" />
    </svg>
  );
}

export function IconClose({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(size)} {...rest}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

// Alias — spec asks for IconX too.
export const IconX = IconClose;

export function IconAlert({ size = 18, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(size)} {...rest}>
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    </svg>
  );
}

export function IconFolder({ size = 16, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(size)} {...rest}>
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.4l2 2h7.6A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" />
    </svg>
  );
}

export function IconCode({ size = 18, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(size)} {...rest}>
      <path d="m9 8-4 4 4 4" />
      <path d="m15 8 4 4-4 4" />
    </svg>
  );
}

export function IconDashboard({ size = 18, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(size)} {...rest}>
      <rect x="3" y="3" width="8" height="10" rx="1.5" />
      <rect x="13" y="3" width="8" height="6" rx="1.5" />
      <rect x="13" y="11" width="8" height="10" rx="1.5" />
      <rect x="3" y="15" width="8" height="6" rx="1.5" />
    </svg>
  );
}

export function IconRefresh({ size = 14, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(size)} {...rest}>
      <path d="M3 12a9 9 0 0 1 15.5-6.4L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.4L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

export function IconBranch({ size = 14, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(size)} {...rest}>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="9" r="2" />
      <path d="M6 7v10" />
      <path d="M6 13c0-2.5 2-4 4.5-4H16" />
    </svg>
  );
}

export function IconPlay({ size = 14, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(size)} {...rest} fill="currentColor" stroke="none">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

export function IconRuns({ size = 18, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(size)} {...rest}>
      <path d="M4 7h12" />
      <path d="M4 12h16" />
      <path d="M4 17h8" />
      <circle cx="20" cy="17" r="2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function IconPullRequest({ size = 18, ...rest }: IconProps): JSX.Element {
  return (
    <svg {...baseProps(size)} {...rest}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M6 8v8" />
      <path d="M11 6h5a2 2 0 0 1 2 2v8" />
      <path d="m14 9 4-3-4-3" />
    </svg>
  );
}
