import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { launchOptions, root } from './browser-runtime.mjs';

// Build the production renderer and its real DOMPurify dependency, without a global sanitizer.
const build = await Bun.build({ entrypoints: [`${root}/public/rendering.js`], target: 'browser', format: 'esm', minify: true });
assert.ok(build.success, build.logs.join('\n'));
const bundle = await build.outputs[0].text();
const browser = await chromium.launch(launchOptions());
try {
  const page = await browser.newPage();
  await page.route('http://rendering.test/**', route => route.fulfill({
    contentType: route.request().url().endsWith('/rendering.js') ? 'text/javascript' : 'text/html',
    body: route.request().url().endsWith('/rendering.js') ? bundle : '<!doctype html><div id="output"></div><script type="module">import {renderAssistantMarkdown} from "/rendering.js";window.render=renderAssistantMarkdown;</script>',
  }));
  await page.goto('http://rendering.test/');
  await page.waitForFunction(() => typeof window.render === 'function');
  const payloads = [
    '<iframe srcdoc="&lt;script&gt;parent.__xss=1&lt;/script&gt;">',
    '<a href="javascript&#58;window.__xss=1">click</a>',
    '<a href="java&#x09;script:window.__xss=1">click</a>',
    '<svg><g onload="window.__xss=1"></g></svg>',
    '<img src="invalid" onerror="window.__xss=1">',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=invalid onerror=window.__xss=1>">',
    '\u0000CODEX0\u0000\n\n<iframe srcdoc="&lt;script&gt;parent.__xss=1&lt;/script&gt;">\n\n`safe`',
  ];
  for (const payload of payloads) {
    // Streamed messages render partial HTML too; check each prefix as well as the complete input.
    const result = await page.evaluate(async source => {
      const output = document.querySelector('#output');
      window.__xss = 0;
      for (let length = 1; length <= source.length; length++) {
        output.innerHTML = window.render(source.slice(0, length));
        if (output.querySelector('script,iframe,object,embed,[srcdoc]')) throw new Error('Active embedded content survived');
        for (const element of output.querySelectorAll('*')) {
          for (const attribute of element.attributes) {
            if (/^on/i.test(attribute.name)) throw new Error('Event handler survived');
            if (['href', 'src', 'xlink:href'].includes(attribute.name) && /^javascript:/i.test(attribute.value.replace(/[\u0000-\u0020]/g, ''))) throw new Error('JavaScript URL survived');
          }
        }
      }
      for (const link of output.querySelectorAll('a')) link.click();
      await new Promise(resolve => setTimeout(resolve, 30));
      return { executed: window.__xss, globalSanitizer: typeof window.DOMPurify };
    }, payload);
    assert.equal(result.executed, 0);
    assert.equal(result.globalSanitizer, 'undefined');
  }
  const preserved = await page.evaluate(() => {
    const output = document.querySelector('#output');
    output.innerHTML = window.render('## Result\n\n$E=mc^2$\n\n```js\nconst x = 1 < 2;\n```\n\n[report](sandbox:/tmp/report.pdf)\n\n![preview](/tmp/result.png)', { cwd: '/tmp' });
    return { heading: !!output.querySelector('h2'), math: !!output.querySelector('.katex'), code: output.querySelector('pre code')?.textContent, reference: output.querySelector('a[data-file-reference]')?.getAttribute('href'), image: output.querySelector('.message-image')?.getAttribute('src') };
  });
  assert.ok(preserved.heading && preserved.math);
  assert.equal(preserved.code, 'const x = 1 < 2;');
  assert.equal(preserved.reference, '#file-reference');
  assert.ok(preserved.image?.startsWith('/api/images/local?'));
  console.log(JSON.stringify({ maliciousPayloads: payloads.length, streamedPrefixesChecked: true, preserved }, null, 2));
} finally {
  await browser.close();
}
