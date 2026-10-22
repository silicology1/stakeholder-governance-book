// theme/cairo.js
hljs.registerLanguage('cairo', function (hljs) {
  return {
    name: 'Cairo',
    keywords: {
      keyword:
        'fn let mut const struct enum trait impl mod use pub extern type match ' +
        'if else loop while for in break continue return ref as of self Self ' +
        'super crate nopanic implicits with',
      literal: 'true false',
      built_in:
        'felt252 u8 u16 u32 u64 u128 u256 usize i8 i16 i32 i64 i128 bool ' +
        'Array Span Option Some None Result Ok Err ByteArray Felt252Dict Box ' +
        'Nullable ContractAddress ClassHash',
    },
    contains: [
      hljs.C_LINE_COMMENT_MODE,
      hljs.QUOTE_STRING_MODE,
      { className: 'string', begin: /'[^'\n]*'/ },          // short strings
      { className: 'number', begin: /\b(0x[0-9a-fA-F_]+|\d[\d_]*)(_?(u8|u16|u32|u64|u128|u256|usize|felt252))?\b/ },
      { className: 'meta', begin: /#\[/, end: /\]/ },         // attributes
      { className: 'built_in', begin: /\b\w+!/ },             // macros: assert!, array!
      {
        className: 'function',
        beginKeywords: 'fn',
        end: /[({;]/,
        excludeEnd: true,
        contains: [{ className: 'title', begin: /[a-zA-Z_]\w*/ }],
      },
      { className: 'type', begin: /\b[A-Z][A-Za-z0-9_]*\b/ },
    ],
  };
});

// mdBook may already have highlighted blocks before this ran, so redo the Cairo ones.
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('code.language-cairo').forEach(function (el) {
    el.classList.remove('hljs');
    el.textContent = el.textContent; // strip existing markup
    hljs.highlightBlock(el);
  });
});
