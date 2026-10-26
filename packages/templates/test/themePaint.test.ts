import { describe, expect, it } from 'vitest';
import { createResolver, scaleColorForTheme, setColorLightness } from '@eraserlabs/resolve';
import { stockLibrary, tagSchemas, templateProps } from '../src/index.js';
import { stockNormalizers } from '../src/normalizers.js';

const SURFACES = [
  ['Shape', 0.85],
  ['Legend', 0.85],
  ['Group', 0.98],
  ['Lane', 0.98],
  ['Pool', 0.98],
  ['Activity', 0.96],
  ['Event', 0.96],
  ['Gateway', 0.96],
  ['DatabaseTable', 0.98],
] as const;

describe('stock final paint preparation', () => {
  it('keeps derived paint fields out of every public authoring schema', () => {
    const internalFields = [
      'fillColor',
      'tintColor',
      'titleSurfaceColor',
      'dividerColor',
      'bodyInk',
      'washPaper',
    ];
    for (const [tag, schema] of Object.entries(tagSchemas)) {
      for (const field of internalFields) {
        expect(schema.properties, `${tag}.${field}`).not.toHaveProperty(field);
      }
    }
    expect(templateProps.Shape).toEqual(
      expect.arrayContaining(['fillColor', 'tintColor', 'bodyInk', 'washPaper']),
    );
    // Existing published fields keep their authoring compatibility.
    expect(tagSchemas.Shape!.properties).toHaveProperty('iconColor');
    expect(tagSchemas.Shape!.properties).toHaveProperty('textInk');
    expect(tagSchemas.Shape!.properties).toHaveProperty('washMid');
  });

  it.each(SURFACES)(
    '%s derives its surface before the shared theme transform',
    async (tag, lightness) => {
      const resolver = await createResolver({
        library: stockLibrary,
        normalizers: stockNormalizers,
      });
      const authored = { elements: [{ tag, id: 'node', x: 0, y: 0, color: '#00ffff' }] };
      const light = await resolver.resolve(authored);
      const dark = await resolver.resolve(authored, { theme: 'dark' });
      expect(light.errors).toEqual([]);
      expect(dark.errors).toEqual([]);
      const fill = setColorLightness('#00ffff', lightness);
      expect(light.entities![0]!.props.fillColor).toBe(fill);
      expect(dark.entities![0]!.props.fillColor).toBe(scaleColorForTheme(fill, 'dark'));
      expect(dark.entities![0]!.props.color).toBe(scaleColorForTheme('#00ffff', 'dark'));
      expect(authored.elements[0]!.color).toBe('#00ffff');
    },
  );

  it('explicit backgrounds stay exact and palette spellings receive the same treatment', async () => {
    const resolver = await createResolver({
      library: { ...stockLibrary, palette: { ...stockLibrary.palette, blue: '#00ffff' } },
      normalizers: stockNormalizers,
    });
    const result = await resolver.resolve({
      elements: [
        { tag: 'Shape', id: 'palette', x: 0, y: 0, color: 'blue' },
        { tag: 'Shape', id: 'literal', x: 0, y: 0, color: '#00ffff' },
        {
          tag: 'Group',
          id: 'explicit',
          x: 0,
          y: 0,
          color: 'blue',
          bgColor: '#000000',
          borderColor: '#ffffff',
        },
      ],
    });
    expect(result.errors).toEqual([]);
    const [palette, literal, explicit] = result.entities!;
    expect(palette!.props.fillColor).toBe(literal!.props.fillColor);
    expect(explicit!.props).toMatchObject({
      fillColor: '#000000',
      bgColor: '#000000',
      borderColor: '#ffffff',
    });
  });

  it('title, row divider and watercolor paper are independently transformed final paints', async () => {
    const resolver = await createResolver({ library: stockLibrary, normalizers: stockNormalizers });
    const input = {
      elements: [
        { tag: 'Group', id: 'group', x: 0, y: 0, color: '#2866c4', styleMode: 'watercolor' },
        {
          tag: 'DatabaseTable',
          id: 'table',
          x: 0,
          y: 0,
          color: '#2866c4',
          styleMode: 'watercolor',
        },
      ],
    };
    const light = await resolver.resolve(input);
    const dark = await resolver.resolve(input, { theme: 'dark' });
    expect(light.errors).toEqual([]);
    expect(dark.errors).toEqual([]);
    for (const [index, entity] of light.entities!.entries()) {
      const themed = dark.entities![index]!.props;
      for (const field of [
        'fillColor',
        'tintColor',
        'titleSurfaceColor',
        'dividerColor',
        'washShade',
        'washMid',
        'washPaper',
      ]) {
        if (typeof entity.props[field] === 'string') {
          expect(themed[field], `${entity.tag}.${field}`).toBe(
            scaleColorForTheme(entity.props[field] as string, 'dark'),
          );
        }
      }
      expect(themed.washPaper).toBe('#171717');
    }
  });
});
