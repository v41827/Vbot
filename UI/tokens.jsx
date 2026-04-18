// Design tokens — Duolingo x V-Bot
// Cream-warm, confident type, generous air. Red + green are the main accents.

const T = {
  // surfaces
  cream: '#F6F2EA',        // page bg
  paper: '#FBF8F1',        // card bg (lighter than page)
  paperDeep: '#EFE9DC',    // pressed / subtle well
  line: 'rgba(20,20,19,0.08)',
  lineStrong: 'rgba(20,20,19,0.14)',

  // ink
  ink: '#141413',          // primary text
  inkSoft: '#3A3835',      // secondary
  inkMuted: '#8A857D',     // tertiary
  inkFaint: 'rgba(20,20,19,0.35)',

  // brand — red is the primary accent, green the secondary.
  // The token keys keep their old names ("terracotta", "forest") so every
  // consumer picks up the new hex values without any code changes.
  terracotta: '#CC3545',       // primary accent — red
  terracottaDeep: '#8B232D',
  terracottaSoft: '#F4D2D2',

  // semantic
  forest: '#2D5F3F',       // secondary accent — green (also "good / safe")
  forestSoft: '#CFE3D4',
  amber: '#E3A951',        // warning / energy
  amberSoft: '#F8E6C3',
  rose: '#C85858',         // over-limit / alert (softer red variant)
  roseSoft: '#F4D2D2',

  // charts
  ocean: '#4A7BA6',
  oceanSoft: '#CFDDEA',

  // radii
  rSm: 12,
  rMd: 20,
  rLg: 28,
  rXl: 40,

  // shadows
  shadowSm: '0 1px 2px rgba(20,20,19,0.04), 0 2px 8px rgba(20,20,19,0.04)',
  shadowMd: '0 2px 4px rgba(20,20,19,0.05), 0 12px 32px rgba(20,20,19,0.08)',
  shadowLg: '0 4px 12px rgba(20,20,19,0.06), 0 24px 64px rgba(20,20,19,0.12)',

  // type
  display: '"Instrument Serif", "Times New Roman", serif',
  sans: '"Geist", "Inter", -apple-system, system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, Menlo, monospace',
};

Object.assign(window, { T });
