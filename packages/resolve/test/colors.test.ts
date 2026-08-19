import { describe, it, expect } from 'vitest';
import { isValidColor } from '../src/pipeline/colors.js';

const VALID = [
  'red',
  'blue',
  'rebeccapurple',
  'transparent',
  'currentColor',
  'CurrentColor',
  'WHITE',
  '#fff',
  '#ffff',
  '#ffffff',
  '#ffffffff',
  '#0A7',
  '#0a7f',
  '#12ab34',
  '#12AB34CD',
  'rgb(0,0,0)',
  'rgb(255, 255, 255)',
  'rgba(0,0,0,0.5)',
  'rgba(10, 20, 30, 1)',
  'rgb(50%, 50%, 50%)',
  'rgba(50%,50%,50%,0.2)',
  'hsl(120, 50%, 50%)',
  'hsla(120, 50%, 50%, 0.3)',
  'hsl(120deg, 50%, 50%)',
  'RGB(1,2,3)',
  'HSL(1, 2%, 3%)',
  'aqua',
  'teal',
  'navy',
  'olive',
  'coral',
  'gold',
  'crimson',
  'orchid',
  'salmon',
  'sienna',
  'tomato',
  'orange',
  'pink',
  'plum',
  'tan',
  'green',
  'lime',
  'maroon',
  'silver',
  'gray',
  'grey',
  'indigo',
  'violet',
  'khaki',
  'ivory',
];

const INVALID = [
  '',
  'notacolor',
  'reddd',
  '#ff',
  '#fffff',
  '#gggggg',
  '#12345',
  'rgb()',
  'rgb(1,2)',
  'rgb(1,2,3,4,5)',
  'hsl(1,2,3)',
  'rgb(1 2 3',
  // Injection payloads — all must be rejected by the grammar gate.
  'red;} body{background:url(//evil)}',
  'red; }',
  'url(javascript:alert(1))',
  'var(--x)',
  'expression(alert(1))',
  '#fff;',
  'rgb(0,0,0);color:red',
  'red/**/',
  '<script>',
  'rgb(0,0,0)<',
  'red`',
  'rgba(0,0,0,0.5) }',
  'hsl(1,2%,3%);}',
  'blue{',
  'green}',
  'url(#x)',
  'rgb(0,0,0)/*',
  'attr(x)',
  'calc(1+1)',
  'linear-gradient(red,blue)',
  'red\n',
  'red\\',
  'RED;DROP',
  '#ffffff url(x)',
  'rgb(0,0,0) var(--y)',
];

describe('color grammar (CSS-injection gate)', () => {
  it(`accepts ${VALID.length} valid colors`, () => {
    for (const c of VALID) {
      expect(isValidColor(c), `expected valid: ${c}`).toBe(true);
    }
  });

  it(`rejects ${INVALID.length} invalid / hostile colors`, () => {
    for (const c of INVALID) {
      expect(isValidColor(c), `expected invalid: ${c}`).toBe(false);
    }
  });
});
