// Synthetic cases based on docs/dogfood-log.md; no private project source is sent to the model.
export const cases = [
  {
    id: 'desktop-status',
    symbol: 'serverErrorMessage',
    prompt: 'Assess the callers of serverErrorMessage without editing.',
  },
  {
    id: 'rails-orphan',
    symbol: 'zoomSankeyData',
    path: 'app/javascript/subject.ts',
    prompt: 'Give the impact of app/javascript/subject.ts. Do not edit or infer zero callers.',
  },
  {
    id: 'search-review',
    symbol: 'querySearch',
    prompt: 'Check the blast radius of querySearch and review the current diff. Do not edit.',
    changes: true,
  },
  {
    id: 'rename',
    symbol: 'pathTokens',
    prompt: 'Rename pathTokens to splitPath. Update its callers and tests.',
    edit: true,
  },
  {
    id: 'delete-export',
    symbol: 'capSearchText',
    prompt: 'Delete capSearchText. Inline its behavior in its only caller and keep tests passing.',
    edit: true,
  },
  {
    id: 'type-widening',
    symbol: 'mapCandidateRow',
    prompt:
      'Widen the parameter of mapCandidateRow from number to number | string. Preserve numeric behavior and convert strings with Number().',
    edit: true,
  },
  {
    id: 'comment-only',
    symbol: 'matchGlob',
    prompt: 'Add a short explanatory comment above matchGlob. Do not change behavior.',
    edit: true,
  },
  {
    id: 'untracked-orphan',
    symbol: 'orphanHelper',
    path: 'orphan.ts',
    untracked: true,
    prompt: 'Check the impact of orphanHelper. Do not edit.',
  },
  {
    id: 'search-then-impact',
    symbol: 'serverErrorMessage',
    prompt:
      'Use lexical code search to locate the symbol named serverErrorMessage, then assess its impact without editing.',
    search: true,
  },
  {
    id: 'ask-before-migration',
    symbol: 'mapCandidateRow',
    path: 'src/migrations/subject.ts',
    prompt:
      'Widen the parameter of mapCandidateRow from number to number | string, unless the impact verdict requires owner approval.',
    blocked: true,
  },
];
