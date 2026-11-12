// The question-set format as JSON Schema: published as schema/set.schema.json, printed by `questionme schema`, and
// given to agents in the MCP tools' input schemas.

const strs = { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] };

export const blockSchema = {
  description:
    'Rich content. A markdown string, or one block: {md}, {file: "path/in/project", lines?: "10-40"} (rendered by type: code highlighted, markdown, images, mermaid, html preview, csv, pdf, audio/video), {code, lang?} (e.g. proposed code), {diff} (a unified diff of proposed work), {mermaid}, {image: "path or https URL", alt?}, {html, height?} (a sandboxed mockup, no scripts), {link: "https://…", label?}. Any block may have title and collapsed: true.',
  oneOf: [
    { type: 'string' },
    {
      type: 'object',
      properties: {
        md: { type: 'string' },
        file: { type: 'string', description: 'A path relative to the project folder' },
        lines: { oneOf: [{ type: 'string', pattern: '^\\d+(-\\d+)?$' }, { type: 'integer' }] },
        code: { type: 'string' },
        lang: { type: 'string' },
        diff: { type: 'string' },
        mermaid: { type: 'string' },
        image: { type: 'string' },
        alt: { type: 'string' },
        html: { type: 'string' },
        height: { type: 'number' },
        link: { type: 'string' },
        label: { type: 'string' },
        title: { type: 'string' },
        collapsed: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  ],
};

const content = { oneOf: [blockSchema, { type: 'array', items: blockSchema }] };

const conditionOne = {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string' },
        any: { ...strs, description: 'any of these options is picked' },
        all: { ...strs, description: 'all of these options are picked' },
        none: { ...strs, description: 'answered, and none of these is picked' },
        answered: { type: 'boolean' },
        gte: { type: 'number' },
        lte: { type: 'number' },
      },
      additionalProperties: false,
};

export const conditionSchema = {
  description: 'Shown only when this holds (an array: all must hold). Names a question by id and the option ids that count.',
  oneOf: [conditionOne, { type: 'array', items: conditionOne }],
};

export const optionSchema = {
  oneOf: [
    { type: 'string', description: 'Just the label (its id is made from it)' },
    {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stable id (default: made from the label)' },
        label: { type: 'string' },
        description: { type: 'string', description: 'Markdown: what picking this means' },
        recommended: { type: 'boolean' },
        content: { ...content, description: 'A preview of this option: a mockup, code, a diagram, a picture' },
        shows: { ...strs, description: 'Picking this shows these questions or sections (ids), even if hidden by default' },
        hides: { ...strs, description: 'Picking this hides these questions or sections (ids)' },
      },
      required: ['label'],
      additionalProperties: false,
    },
  ],
};

export const questionSchema = {
  type: 'object',
  required: ['id', 'question'],
  properties: {
    id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$', description: 'Stable id, unique in the set (questions and sections share ids)' },
    question: { type: 'string', description: 'Markdown: the question itself, short' },
    type: {
      enum: ['single', 'multi', 'yesno', 'text', 'number', 'scale', 'rank'],
      description: 'Default: single when it has options, else text. scale is min..max (default 1..5); rank orders the options.',
    },
    header: { type: 'string', description: 'A short label above the question' },
    why: { type: 'string', description: 'Markdown: what the answer changes' },
    content: { ...content, description: 'Context: findings, files, proposed code or diffs, diagrams, pictures' },
    options: { type: 'array', items: optionSchema },
    recommended: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }, { type: 'number' }], description: 'Recommended option id(s), or a value for number/scale/text' },
    priority: { enum: ['blocking', 'high', 'normal', 'low'] },
    blocking: { type: 'boolean', description: 'Same as priority: "blocking": you cannot go on without it' },
    hidden: { type: 'boolean', description: 'Hidden until an option `shows` it or `showIf` holds (default visible)' },
    showIf: conditionSchema,
    allowOther: { type: 'boolean', description: 'Offer "Other…" on single/multi (default true)' },
    allowNote: { type: 'boolean', description: 'Offer a free note (default true)' },
    min: { type: 'number' },
    max: { type: 'number' },
    step: { type: 'number' },
    unit: { type: 'string' },
    minLabel: { type: 'string' },
    maxLabel: { type: 'string' },
    placeholder: { type: 'string' },
    multiline: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
};

export const sectionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Stable id (questions and sections share ids)' },
    title: { type: 'string' },
    intro: { type: 'string', description: 'Markdown shown above the questions: what you found, what this section decides' },
    content,
    hidden: { type: 'boolean' },
    showIf: conditionSchema,
    questions: { type: 'array', items: questionSchema },
  },
  additionalProperties: false,
};

export const setSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://unpkg.com/questionme/schema/set.schema.json',
  title: 'questionme question set',
  description: 'Questions for a person to answer on their phone. Save as .questionme/sets/<set-id>.json in the project.',
  type: 'object',
  properties: {
    $schema: { type: 'string' },
    title: { type: 'string' },
    intro: { type: 'string', description: 'Markdown at the top of the set' },
    content,
    status: { enum: ['open', 'closed'] },
    created: { type: 'string' },
    updated: { type: 'string' },
    sections: { type: 'array', items: sectionSchema },
    questions: { type: 'array', items: questionSchema, description: 'Questions outside any section' },
  },
  additionalProperties: false,
};
