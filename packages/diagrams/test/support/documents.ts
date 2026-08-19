import type { DiagramInput } from '@eraserlabs/resolve';

/**
 * Test-owned documents, inlined from the retired fixtures/features files (all-tags,
 * connections). all-tags keeps one of every stock tag (11 elements) so the mount sweep and
 * airgap probes keep their coverage; connections keeps the edge + self-loop pair.
 */

export const allTagsDocument: DiagramInput = {
  elements: [
    {
      tag: 'Icon',
      id: 'i1',
      x: 0,
      y: 0,
      icon: 'lucide-database',
      size: 'md',
      texts: [
        {
          text: 'DB',
        },
      ],
    },
    {
      tag: 'Shape',
      id: 's1',
      x: 200,
      y: 0,
      width: 140,
      height: 70,
      shape: 'rectangle',
      styleMode: 'plain',
      bgColor: '#eef',
      texts: [
        {
          text: 'Service',
        },
      ],
      badge: {
        text: '3',
      },
    },
    {
      tag: 'DatabaseTable',
      id: 't1',
      x: 400,
      y: 0,
      label: 'users',
      fields: [
        {
          name: 'id',
          type: 'uuid',
        },
        {
          name: 'email',
          type: 'text',
        },
      ],
    },
    {
      tag: 'Textbox',
      id: 'tb1',
      x: 0,
      y: 120,
      text: 'A note',
    },
    {
      tag: 'Group',
      id: 'g1',
      x: 0,
      y: 200,
      width: 300,
      height: 160,
      title: {
        text: 'Cluster',
      },
    },
    {
      tag: 'Lane',
      id: 'l1',
      x: 0,
      y: 400,
      width: 300,
      height: 120,
      title: {
        text: 'Lane A',
      },
    },
    {
      tag: 'Pool',
      id: 'p1',
      x: 0,
      y: 540,
      width: 300,
      height: 120,
      title: {
        text: 'Pool A',
      },
    },
    {
      tag: 'Divider',
      id: 'd1',
      x: 0,
      y: 700,
      width: 300,
      orientation: 'horizontal',
      label: 'Section',
    },
    {
      tag: 'Legend',
      id: 'lg1',
      x: 400,
      y: 400,
      entries: [
        {
          text: 'primary',
          color: '#0a7',
        },
        {
          text: 'uncolored',
        },
      ],
    },
    {
      tag: 'Relationship',
      id: 'r1',
      x: 0,
      y: 0,
      from: 's1',
      to: 't1',
      points: [
        {
          x: 340,
          y: 35,
        },
        {
          x: 400,
          y: 35,
        },
      ],
      label: 'reads',
      endArrowhead: 'arrow',
    },
    {
      tag: 'DatabaseRelationship',
      id: 'r2',
      x: 0,
      y: 0,
      from: 't1',
      to: 's1',
      points: [
        {
          x: 400,
          y: 60,
        },
        {
          x: 340,
          y: 60,
        },
      ],
      notation: 'crows-foot',
    },
  ],
};

export const connectionsDocument: DiagramInput = {
  elements: [
    {
      tag: 'Shape',
      id: 'a',
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      texts: [
        {
          text: 'A',
        },
      ],
    },
    {
      tag: 'Shape',
      id: 'b',
      x: 300,
      y: 0,
      width: 100,
      height: 50,
      texts: [
        {
          text: 'B',
        },
      ],
    },
    {
      tag: 'Relationship',
      id: 'r1',
      x: 0,
      y: 0,
      from: 'a',
      to: 'b',
      points: [
        {
          x: 100,
          y: 25,
        },
        {
          x: 300,
          y: 25,
        },
      ],
      label: 'links to',
    },
    {
      tag: 'Relationship',
      id: 'r2',
      x: 0,
      y: 0,
      from: 'a',
      to: 'a',
      points: [
        {
          x: 10,
          y: 0,
        },
        {
          x: 10,
          y: -20,
        },
        {
          x: 40,
          y: -20,
        },
      ],
      label: 'self',
    },
  ],
};
