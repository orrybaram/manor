/**
 * Source map symbolication script — injected into a webview via
 * `webContents.executeJavaScript()` to provide source map resolution
 * for React component stacks.
 *
 * Exposes `window.__manor_symbolication__` with:
 *   - `symbolicateFrame(fileName, lineNumber, columnNumber)` — resolve to original source
 *   - `normalizeFileName(fileName)` — strip bundler prefixes and query strings
 *   - `isSourceFile(fileName)` — filter out vendor/generated files
 */

export const SYMBOLICATION_SCRIPT = `(function() {
  // Guard against double-injection
  if (window.__manor_symbolication__) return;

  // Source map cache keyed by bundle URL
  if (!window.__manor_sourcemap_cache__) {
    window.__manor_sourcemap_cache__ = {};
  }
  var cache = window.__manor_sourcemap_cache__;

  // ── VLQ Decoder ──────────────────────────────────────────────────────────

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var b64Lookup = {};
  for (var i = 0; i < B64.length; i++) {
    b64Lookup[B64.charAt(i)] = i;
  }

  function decodeVLQ(mappings) {
    var decoded = [[]];
    var line = 0;
    var col = 0;
    var srcIdx = 0;
    var srcLine = 0;
    var srcCol = 0;
    var nameIdx = 0;
    var pos = 0;
    var len = mappings.length;

    while (pos < len) {
      var ch = mappings.charAt(pos);

      if (ch === ';') {
        line++;
        col = 0;
        decoded.push([]);
        pos++;
        continue;
      }

      if (ch === ',') {
        pos++;
        continue;
      }

      // Decode a segment of VLQ values
      var segment = [];
      for (var j = 0; j < 5 && pos < len; j++) {
        var value = 0;
        var shift = 0;
        var continuation = true;

        while (continuation && pos < len) {
          var c = mappings.charAt(pos);
          if (c === ',' || c === ';') {
            continuation = false;
            break;
          }
          var digit = b64Lookup[c];
          if (digit === undefined) { pos++; break; }
          continuation = (digit & 32) !== 0;
          value = value + ((digit & 31) << shift);
          shift += 5;
          pos++;
        }

        if (shift > 0 || value > 0) {
          var negate = (value & 1) !== 0;
          value = value >> 1;
          if (negate) value = -value;
          segment.push(value);
        }

        if (pos < len) {
          var next = mappings.charAt(pos);
          if (next === ',' || next === ';') break;
        }
      }

      if (segment.length >= 1) {
        col += segment[0];
        var entry = [col];
        if (segment.length >= 4) {
          srcIdx += segment[1];
          srcLine += segment[2];
          srcCol += segment[3];
          entry.push(srcIdx, srcLine, srcCol);
          if (segment.length >= 5) {
            nameIdx += segment[4];
            entry.push(nameIdx);
          }
        }
        decoded[line].push(entry);
      }
    }

    return decoded;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  function fetchWithTimeout(url, timeoutMs) {
    return new Promise(function(resolve, reject) {
      var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = setTimeout(function() {
        if (controller) controller.abort();
        reject(new Error('fetch timeout'));
      }, timeoutMs || 2000);

      fetch(url, controller ? { signal: controller.signal } : {})
        .then(function(res) {
          clearTimeout(timer);
          resolve(res);
        })
        .catch(function(err) {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  function extractSourceMappingURL(content) {
    // Check last 500 chars for the sourceMappingURL comment
    var tail = content.slice(-500);
    var match = tail.match(/\\/\\/[#@]\\s*sourceMappingURL=(.+?)\\s*$/m);
    if (match) return match[1];
    // Also check for multi-line comment style
    match = tail.match(/\\/\\*[#@]\\s*sourceMappingURL=(.+?)\\s*\\*\\//);
    return match ? match[1] : null;
  }

  function resolveURL(baseURL, relative) {
    try {
      return new URL(relative, baseURL).href;
    } catch (e) {
      // Fallback: simple path resolution
      var baseParts = baseURL.split('/');
      baseParts.pop(); // remove filename
      return baseParts.join('/') + '/' + relative;
    }
  }

  function decodeBase64(str) {
    try {
      return atob(str);
    } catch (e) {
      return null;
    }
  }

  // Binary search for the segment matching a given column in a line's segments
  function findSegment(segments, column) {
    if (!segments || segments.length === 0) return null;

    var lo = 0;
    var hi = segments.length - 1;
    var best = null;

    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var genCol = segments[mid][0];

      if (genCol === column) {
        return segments[mid];
      } else if (genCol < column) {
        best = segments[mid];
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    return best;
  }

  // ── Core functions ───────────────────────────────────────────────────────

  function normalizeFileName(fileName) {
    if (!fileName || typeof fileName !== 'string') return '';
    var f = fileName;
    // Strip bundler protocol prefixes
    f = f.replace(/^webpack-internal:\\/\\/\\//, '');
    f = f.replace(/^webpack:\\/\\/\\/\\.\\//, '');
    f = f.replace(/^webpack:\\/\\/\\//, '');
    // Strip webpack://appName/ pattern
    f = f.replace(/^webpack:\\/\\/[^/]+\\//, '');
    f = f.replace(/^turbopack:\\/\\//, '');
    f = f.replace(/^file:\\/\\/\\//, '/');
    // Remove query strings and hash fragments
    f = f.replace(/[?#].*$/, '');
    return f;
  }

  function isSourceFile(fileName) {
    if (!fileName || typeof fileName !== 'string') return false;
    var f = normalizeFileName(fileName);
    // Exclusion patterns
    if (/node_modules/.test(f)) return false;
    if (/[\\/\\\\]\\.next[\\/\\\\]/.test(f) || /^\\.next[\\/\\\\]/.test(f)) return false;
    if (/[\\/\\\\]dist[\\/\\\\]/.test(f) || /[\\/\\\\]build[\\/\\\\]/.test(f)) return false;
    if (/\\/dist$/.test(f) || /\\/build$/.test(f)) return false;
    // Generated chunk patterns
    var basename = f.split('/').pop() || '';
    if (/^chunk-/.test(basename)) return false;
    if (/^vendor-/.test(basename)) return false;
    if (/^runtime-/.test(basename)) return false;
    if (/\\.min\\.js$/.test(basename)) return false;
    // Hex hash filenames (e.g. a1b2c3d4.js)
    if (/^[0-9a-f]{6,}\\.(js|mjs)$/.test(basename)) return false;
    return true;
  }

  function symbolicateFrame(fileName, lineNumber, columnNumber) {
    return new Promise(function(resolve) {
      try {
        // Check cache first
        if (cache[fileName]) {
          var result = lookupInSourceMap(cache[fileName], lineNumber, columnNumber);
          resolve(result);
          return;
        }

        // Fetch the bundle file
        fetchWithTimeout(fileName, 2000)
          .then(function(res) {
            if (!res.ok) { resolve(null); return; }
            return res.text();
          })
          .then(function(bundleContent) {
            if (!bundleContent) { resolve(null); return; }

            var mappingURL = extractSourceMappingURL(bundleContent);
            if (!mappingURL) { resolve(null); return; }

            // Handle inline source maps
            var dataMatch = mappingURL.match(/^data:application\\/json;(?:charset=[^;]+;)?base64,(.+)$/);
            if (dataMatch) {
              var jsonStr = decodeBase64(dataMatch[1]);
              if (!jsonStr) { resolve(null); return; }
              try {
                var sm = JSON.parse(jsonStr);
                var parsed = parseSourceMap(sm);
                cache[fileName] = parsed;
                resolve(lookupInSourceMap(parsed, lineNumber, columnNumber));
              } catch (e) {
                resolve(null);
              }
              return;
            }

            // External source map
            var smURL = resolveURL(fileName, mappingURL);
            return fetchWithTimeout(smURL, 2000)
              .then(function(smRes) {
                if (!smRes.ok) { resolve(null); return; }
                return smRes.json();
              })
              .then(function(sm) {
                if (!sm) { resolve(null); return; }
                var parsed = parseSourceMap(sm);
                cache[fileName] = parsed;
                resolve(lookupInSourceMap(parsed, lineNumber, columnNumber));
              });
          })
          .catch(function() {
            resolve(null);
          });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function parseSourceMap(sm) {
    return {
      sources: sm.sources || [],
      mappings: decodeVLQ(sm.mappings || ''),
      sourceRoot: sm.sourceRoot || ''
    };
  }

  function lookupInSourceMap(parsed, lineNumber, columnNumber) {
    try {
      // Source maps are 0-based, but lineNumber is typically 1-based
      var genLine = lineNumber - 1;
      if (genLine < 0 || genLine >= parsed.mappings.length) return null;

      var segments = parsed.mappings[genLine];
      if (!segments || segments.length === 0) return null;

      var segment = findSegment(segments, (columnNumber || 1) - 1);
      if (!segment || segment.length < 4) return null;

      var sourceIndex = segment[1];
      var originalLine = segment[2] + 1; // convert back to 1-based
      var originalColumn = segment[3] + 1;

      if (sourceIndex < 0 || sourceIndex >= parsed.sources.length) return null;

      var sourceName = parsed.sources[sourceIndex];
      if (parsed.sourceRoot && sourceName.indexOf('/') !== 0 && sourceName.indexOf(':') === -1) {
        sourceName = parsed.sourceRoot + sourceName;
      }

      return {
        fileName: sourceName,
        lineNumber: originalLine,
        columnNumber: originalColumn
      };
    } catch (e) {
      return null;
    }
  }

  // ── Export ────────────────────────────────────────────────────────────────

  window.__manor_symbolication__ = {
    symbolicateFrame: symbolicateFrame,
    normalizeFileName: normalizeFileName,
    isSourceFile: isSourceFile
  };
})();`;
