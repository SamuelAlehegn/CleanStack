import type { SVGProps } from 'react';

export type IconName =
  | 'archive'
  | 'arrow-left'
  | 'arrow-right'
  | 'check'
  | 'chevron-down'
  | 'chevron-right'
  | 'code'
  | 'copy'
  | 'database'
  | 'download'
  | 'eye'
  | 'file'
  | 'folder'
  | 'home'
  | 'layers'
  | 'plus'
  | 'refresh'
  | 'search'
  | 'sparkles'
  | 'terminal'
  | 'trash'
  | 'warning';

const paths: Record<IconName, string[]> = {
  archive: ['M3 7h18v13H3z', 'm3 7 2-3h14l2 3', 'M8 12h8'],
  'arrow-left': ['M19 12H5', 'm11 18-6-6 6-6'],
  'arrow-right': ['M5 12h14', 'm13 6 6 6-6 6'],
  check: ['m5 12 4 4L19 6'],
  'chevron-down': ['m6 9 6 6 6-6'],
  'chevron-right': ['m9 6 6 6-6 6'],
  code: ['m8 9-3 3 3 3', 'm16 9 3 3-3 3', 'm14 5-4 14'],
  copy: ['M9 9h9v9H9z', 'M5 15H4V4h11v1'],
  database: [
    'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Z',
    'M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6',
    'M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  ],
  download: ['M12 3v12', 'm7 10 5 5 5-5', 'M4 21h16'],
  eye: ['M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z'],
  file: ['M6 3h8l4 4v14H6z', 'M14 3v5h5'],
  folder: ['M3 6h7l2 2h9v11H3z'],
  home: ['m3 11 9-7 9 7', 'M5 10v10h14V10', 'M9 20v-6h6v6'],
  layers: ['m12 3 9 5-9 5-9-5 9-5Z', 'm3 12 9 5 9-5', 'm3 16 9 5 9-5'],
  plus: ['M12 5v14', 'M5 12h14'],
  refresh: ['M20 11a8 8 0 0 0-14-5l-2 2', 'M4 13a8 8 0 0 0 14 5l2-2', 'M4 4v4h4', 'M20 20v-4h-4'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'm21 21-4.3-4.3'],
  sparkles: [
    'm12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3Z',
    'm19 14 .8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8L19 14Z',
  ],
  terminal: ['m4 5 16 0 0 14-16 0z', 'm8 10 3 2-3 2', 'M13 15h4'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'm6 7 1 13h10l1-13', 'M10 11v5', 'M14 11v5'],
  warning: ['M12 3 2.5 20h19L12 3Z', 'M12 9v5', 'M12 17h.01'],
};

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      {...props}
    >
      {paths[name].map((path) => (
        <path d={path} key={path} />
      ))}
    </svg>
  );
}

export function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}
