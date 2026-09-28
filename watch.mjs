// watch.mjs - 开发模式：监听 src 改动，自动重建 dist 下的三个 IIFE 脚本
// 用法：npm run watch
// 覆盖：content-script.ts / background.ts / popup.js（含其全部 import 依赖）
// 不覆盖：popup.html / manifest（很少改，改了手动跑一次 npm run build）
import * as esbuild from 'esbuild';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, 'dist');

const common = {
  bundle: true,
  format: 'iife',
  minify: false,
  sourcemap: false,
  target: ['chrome105'],
  platform: 'browser',
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env.DEEPSEEK_API_KEY': JSON.stringify(process.env.DEEPSEEK_API_KEY || '')
  }
};

async function main() {
  const ctxCS = await esbuild.context({
    ...common,
    entryPoints: [join(__dirname, 'src/content-script.ts')],
    outfile: join(distDir, 'content-script.js'),
    globalName: 'MangaLensContent'
  });

  const ctxBG = await esbuild.context({
    ...common,
    entryPoints: [join(__dirname, 'src/background.ts')],
    outfile: join(distDir, 'background.js'),
    globalName: 'MangaLensBackground'
  });

  const ctxPopup = await esbuild.context({
    ...common,
    entryPoints: [join(__dirname, 'src/popup/popup.js')],
    outfile: join(distDir, 'popup.js'),
    globalName: 'MangaLensPopup'
  });

  // 启动监听（首次会立即构建一次）
  await ctxCS.watch();
  await ctxBG.watch();
  await ctxPopup.watch();

  console.log('👀 MangaLens watch 已启动（Ctrl+C 退出）');
  console.log('   监听中：src/** 下被这三个入口引用的所有文件');
  console.log('   改动后会自动重建 dist/ 下的 content-script.js / background.js / popup.js');
  console.log('   提示：构建完成后到 chrome://extensions 点刷新 + 页面 F5 才会生效');
}

main().catch((e) => {
  console.error('watch 启动失败:', e);
  process.exit(1);
});
