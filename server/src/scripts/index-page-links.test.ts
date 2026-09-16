import assert from "node:assert/strict";
import { test } from "node:test";
import { enumerateSameFolderLinks } from "./index-page-links.js";

const INDEX_URL = "https://xiaolincoding.com/network/";

test("收同前缀的 .html 链接", () => {
  const html = `
    <html><body>
      <a href="https://xiaolincoding.com/network/3_tcp/tcp_no_listen.html">tcp</a>
    </body></html>
  `;
  const links = enumerateSameFolderLinks(html, INDEX_URL);
  assert.deepEqual(links, ["https://xiaolincoding.com/network/3_tcp/tcp_no_listen.html"]);
});

test("不收站外链接", () => {
  const html = `<a href="https://other-site.com/network/a.html">外站</a>`;
  const links = enumerateSameFolderLinks(html, INDEX_URL);
  assert.deepEqual(links, []);
});

test("不收其他目录（/os/）的链接", () => {
  const html = `<a href="https://xiaolincoding.com/os/basic/a.html">os</a>`;
  const links = enumerateSameFolderLinks(html, INDEX_URL);
  assert.deepEqual(links, []);
});

test("不收非 .html 的静态资源", () => {
  const html = `
    <a href="https://xiaolincoding.com/network/assets/app.js">js</a>
    <a href="https://xiaolincoding.com/network/assets/style.css">css</a>
  `;
  const links = enumerateSameFolderLinks(html, INDEX_URL);
  assert.deepEqual(links, []);
});

test("相对路径正确解析：子目录、当前目录、上一级目录", () => {
  const html = `
    <a href="3_tcp/x.html">子目录</a>
    <a href="./y.html">当前目录</a>
    <a href="../network/z.html">上一级又回到 network</a>
  `;
  const links = enumerateSameFolderLinks(html, INDEX_URL);
  assert.deepEqual(links, [
    "https://xiaolincoding.com/network/3_tcp/x.html",
    "https://xiaolincoding.com/network/y.html",
    "https://xiaolincoding.com/network/z.html",
  ]);
});

test("去掉 fragment，且按 fragment 前的 URL 去重", () => {
  const html = `
    <a href="https://xiaolincoding.com/network/a.html#section1">a1</a>
    <a href="https://xiaolincoding.com/network/a.html#section2">a2</a>
    <a href="https://xiaolincoding.com/network/a.html">a3</a>
  `;
  const links = enumerateSameFolderLinks(html, INDEX_URL);
  assert.deepEqual(links, ["https://xiaolincoding.com/network/a.html"]);
});

test("保持首次出现的顺序", () => {
  const html = `
    <a href="https://xiaolincoding.com/network/b.html">b</a>
    <a href="https://xiaolincoding.com/network/a.html">a</a>
    <a href="https://xiaolincoding.com/network/b.html">b 又出现一次</a>
  `;
  const links = enumerateSameFolderLinks(html, INDEX_URL);
  assert.deepEqual(links, [
    "https://xiaolincoding.com/network/b.html",
    "https://xiaolincoding.com/network/a.html",
  ]);
});

test("排除索引页自身", () => {
  const html = `<a href="https://xiaolincoding.com/network/">回到目录首页</a>`;
  const links = enumerateSameFolderLinks(html, INDEX_URL);
  assert.deepEqual(links, []);
});

test("伪协议链接因前缀不匹配被过滤，不误收", () => {
  const html = `
    <a href="javascript:void(0)">伪协议</a>
    <a href="https://xiaolincoding.com/network/real.html">真实链接</a>
  `;
  const links = enumerateSameFolderLinks(html, INDEX_URL);
  assert.deepEqual(links, ["https://xiaolincoding.com/network/real.html"]);
});

test("无法解析的 href 被跳过，不抛异常", () => {
  const html = `
    <a href="http:// invalid">格式错误</a>
    <a href="https://xiaolincoding.com/network/real.html">真实链接</a>
  `;
  const links = enumerateSameFolderLinks(html, INDEX_URL);
  assert.deepEqual(links, ["https://xiaolincoding.com/network/real.html"]);
});
