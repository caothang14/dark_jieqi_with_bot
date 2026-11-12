/*
 * Bot files, loaded in exactly this order (paths relative to the bots/ folder).
 * Adding a bot = create a file in bots/ and add its name here. Both the UI and the arena read this list.
 */
(function (root) {
  const files = [
    'lib/common.js',
    'lib/eval.js',
    'lib/opening.js',
    'random.js',
    'greedy.js',
    'eval1.js',
    'search.js',
    'search_v3.js',
    'levels.js',
  ];
  if (typeof module !== 'undefined' && module.exports) module.exports = files;
  else root.JieqiBotManifest = files;
})(typeof globalThis !== 'undefined' ? globalThis : this);
