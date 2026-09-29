const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const fragmentDirectory = path.join(projectRoot, 'src', 'html');
const outputPath = path.join(projectRoot, 'index.html');
const assetManifestPath = path.join(projectRoot, 'asset-manifest.json');
const fragmentManifestPath = path.join(projectRoot, 'html-fragments.json');
const scriptManifestPath = path.join(projectRoot, 'modules', 'bootstrap', 'html-fragment-manifest.js');
const generatedFragmentDirectory = path.join(projectRoot, 'generated', 'html-fragments');
const feedbackAssetRevision = 'feedback-20260929';
const layoutAssetRevision = 'ios-layout-rollback-20260929';

const fragments = [
  'document-head.html',
  'intro-and-home.html',
  'health-and-couple.html',
  'cphone.html',
  'myphone.html',
  'worldbook-and-presets.html',
  'api-settings-core.html',
  'api-settings-providers.html',
  'api-settings-data.html',
  'data-and-social-list.html',
  'chat-interface.html',
  'appearance-and-thoughts.html',
  'calls-and-social.html',
  'chat-settings-main.html',
  'chat-settings-extra.html',
  'feature-screens.html',
  'modals-general.html',
  'modals-feature.html',
  'modals-phone-and-finance.html',
  'online-and-myphone-modals.html',
  'games-and-document-tail.html'
];

const generatedHtml = fragments
  .map(fragment => fs.readFileSync(path.join(fragmentDirectory, fragment), 'utf8'))
  .join('');

const fragmentScripts = fragments.map(fragment => ({
  outputName: fragment.replace(/\.html$/, '.js'),
  source: fs.readFileSync(path.join(fragmentDirectory, fragment), 'utf8')
}));

const fragmentScriptPaths = fragmentScripts.map(fragment => {
  const path = `generated/html-fragments/${fragment.outputName}`;
  if (fragment.outputName === 'document-head.js') return `${path}?v=${layoutAssetRevision}`;
  if (fragment.outputName === 'api-settings-data.js') return `${path}?v=${feedbackAssetRevision}`;
  return path;
});

const embeddedAssets = [
  'archive/330--main/index.html',
  'tutorial.html'
];

const generatedFragmentScripts = fragmentScripts.map((fragment, index) => ({
  ...fragment,
  contents: `window.__EPHONE_HTML_PARTS[${index}] = ${JSON.stringify(fragment.source)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')};\n`
}));

const generatedScriptManifest = `window.__EPHONE_HTML_FRAGMENT_SCRIPTS = ${JSON.stringify(
  fragmentScriptPaths,
  null,
  2
)};\n`;

const generatedShell = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="theme-color" content="#000000">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="EPhone">
  <title>EPhone</title>
  <link rel="manifest" href="manifest.json?v=0.0.36-pwa2">
  <link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png">
  <link rel="apple-touch-icon" href="icons/icon-192.png">
  <script src="modules/bootstrap/register-service-worker.js"></script>
</head>
<body>
  <noscript>此应用需要启用 JavaScript。</noscript>
  <script src="modules/bootstrap/html-fragment-manifest.js?v=${layoutAssetRevision}"></script>
  <script src="modules/bootstrap/document-loader.js"></script>
</body>
</html>
`;

const generatedFragmentManifest = `${JSON.stringify(fragments, null, 2)}\n`;

const localAssets = Array.from(
  generatedHtml.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/gi),
  match => match[1]
)
  .filter(asset => !/^(?:https?:)?\/\//i.test(asset))
  .map(asset => asset.replace(/^\.\//, '').split(/[?#]/, 1)[0])
  .filter(Boolean);

const generatedAssetManifest = `${JSON.stringify(
  Array.from(new Set([
    'index.html',
    'manifest.json',
    'sw.js',
    'html-fragments.json',
    'modules/bootstrap/register-service-worker.js',
    'modules/bootstrap/html-fragment-manifest.js',
    'modules/bootstrap/document-loader.js',
    ...fragmentScriptPaths,
    ...embeddedAssets,
    ...localAssets
  ])),
  null,
  2
)}\n`;

if (process.argv.includes('--check')) {
  const currentHtml = fs.readFileSync(outputPath, 'utf8');
  if (currentHtml !== generatedShell) {
    console.error('index.html is out of sync with the generated document shell.');
    process.exit(1);
  }
  if (fs.readFileSync(fragmentManifestPath, 'utf8') !== generatedFragmentManifest) {
    console.error('html-fragments.json is out of sync with the fragment order.');
    process.exit(1);
  }
  if (fs.readFileSync(scriptManifestPath, 'utf8') !== generatedScriptManifest) {
    console.error('HTML fragment script manifest is out of sync with the fragment order.');
    process.exit(1);
  }
  for (const fragment of generatedFragmentScripts) {
    const output = path.join(generatedFragmentDirectory, fragment.outputName);
    if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== fragment.contents) {
      console.error(`${fragment.outputName} is out of sync with its HTML source fragment.`);
      process.exit(1);
    }
  }
  const currentAssetManifest = fs.readFileSync(assetManifestPath, 'utf8');
  if (currentAssetManifest !== generatedAssetManifest) {
    console.error('asset-manifest.json is out of sync with index.html.');
    process.exit(1);
  }
  console.log(`Document shell and ${fragments.length} HTML fragments verified.`);
} else {
  fs.mkdirSync(generatedFragmentDirectory, { recursive: true });
  fs.writeFileSync(outputPath, generatedShell);
  fs.writeFileSync(fragmentManifestPath, generatedFragmentManifest);
  fs.writeFileSync(scriptManifestPath, generatedScriptManifest);
  for (const fragment of generatedFragmentScripts) {
    fs.writeFileSync(
      path.join(generatedFragmentDirectory, fragment.outputName),
      fragment.contents
    );
  }
  fs.writeFileSync(assetManifestPath, generatedAssetManifest);
  console.log(`Document shell and local scripts generated for ${fragments.length} HTML fragments.`);
}
