// Pennant logo — same shape as the SVG file in /public/pennant.svg, but
// inlined as React so we can color it inline (toolbar size vs. header
// size sometimes wants a different shade in dev tooling). Always uses
// the crayon-orange `colors.pennantOrange`, not the muted accent.

import { colors } from './tokens.js';

export interface PennantProps {
  size?: number;
  color?: string;
}

export function Pennant({ size = 14, color = colors.pennantOrange }: PennantProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {/* mast */}
      <rect x={6}  y={2}  width={2}  height={30} fill={color} />
      {/* stepped-triangle pennant */}
      <rect x={8}  y={4}  width={4}  height={2}  fill={color} />
      <rect x={8}  y={6}  width={8}  height={2}  fill={color} />
      <rect x={8}  y={8}  width={12} height={2}  fill={color} />
      <rect x={8}  y={10} width={14} height={2}  fill={color} />
      <rect x={8}  y={12} width={12} height={2}  fill={color} />
      <rect x={8}  y={14} width={8}  height={2}  fill={color} />
      <rect x={8}  y={16} width={4}  height={2}  fill={color} />
    </svg>
  );
}
