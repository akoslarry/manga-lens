// post-build.js - 使用 esbuild 将脚本打包为 IIFE 格式
import * as esbuild from 'esbuild';
import { readFile, writeFile, readdir, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, 'dist');

// 使用 esbuild 将 content-script 打包为单个 IIFE 文件
async function bundleContentScript() {
  await esbuild.build({
    entryPoints: [join(__dirname, 'src/content-script.ts')],
    bundle: true,
    outfile: join(distDir, 'content-script.js'),
    format: 'iife',
    globalName: 'MangaLensContent',
    minify: false,
    sourcemap: false,
    target: ['chrome105'],
    platform: 'browser',
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.DEEPSEEK_API_KEY': JSON.stringify(process.env.DEEPSEEK_API_KEY || '')
    }
  });
  console.log('✓ content-script.js 打包为 IIFE 格式');
}

// 使用 esbuild 打包 background script
async function bundleBackground() {
  await esbuild.build({
    entryPoints: [join(__dirname, 'src/background.ts')],
    bundle: true,
    outfile: join(distDir, 'background.js'),
    format: 'iife',
    globalName: 'MangaLensBackground',
    minify: false,
    sourcemap: false,
    target: ['chrome105'],
    platform: 'browser',
    define: {
      'process.env.NODE_ENV': '"production"',
      'process.env.DEEPSEEK_API_KEY': JSON.stringify(process.env.DEEPSEEK_API_KEY || '')
    }
  });
  console.log('✓ background.js 打包为 IIFE 格式');
}

// 使用 esbuild 打包 popup script
async function bundlePopup() {
  await esbuild.build({
    entryPoints: [join(__dirname, 'src/popup/popup.js')],
    bundle: true,
    outfile: join(distDir, 'popup.js'),
    format: 'iife',
    globalName: 'MangaLensPopup',
    minify: false,
    sourcemap: false,
    target: ['chrome105'],
    platform: 'browser',
    define: {
      'process.env.DEEPSEEK_API_KEY': JSON.stringify(process.env.DEEPSEEK_API_KEY || '')
    }
  });
  console.log('✓ popup.js 打包为 IIFE 格式');
}

// 修复 popup HTML 中的 script 标签
async function fixPopupHTML() {
  // 尝试多个可能的路径
  let htmlPath = join(distDir, 'src/popup/index.html');
  try {
    await readFile(htmlPath, 'utf-8');
  } catch {
    // 尝试 Vite 默认输出路径
    htmlPath = join(distDir, 'popup.html');
  }
  
  const htmlContent = await readFile(htmlPath, 'utf-8');
  
  // 将 <script type="module" crossorigin src="/popup.js"></script>
  // 改为 <script src="/popup.js"></script>
  const fixedHtml = htmlContent.replace(
    /<script type="module" crossorigin src="\/popup\.js"><\/script>/,
    '<script src="/popup.js"></script>'
  );
  
  await writeFile(htmlPath, fixedHtml);
  console.log('✓ popup HTML 已修复');
}

// 清理 Vite 生成的不需要文件
async function cleanup() {
  try {
    const assetsDir = join(distDir, 'assets');
    await rm(assetsDir, { recursive: true, force: true });
    console.log('✓ 清理了 assets 目录');
  } catch (e) {
    // 忽略
  }
}

async function main() {
  try {
    await bundleContentScript();
    await bundleBackground();
    await bundlePopup();
    await fixPopupHTML();
    await cleanup();
    console.log('\n✅ 所有脚本已打包为 IIFE 格式！');
  } catch (error) {
    console.error('打包失败:', error);
    process.exit(1);
  }
}

main();
