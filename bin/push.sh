#!/bin/bash
#
# launchd 的入口（ADR-0004：定时触发用 launchd，不起常驻进程）。
#
# 为什么需要这层包装，而不是让 plist 直接写 `npm run push`：
# launchd **不读任何 shell 配置**（.zshrc / .zshenv / .zprofile 都不读），
# 而本机的 node 是 nvm 装的——nvm 正是靠改 shell 配置把 node 塞进 PATH 的。
# 实测（`env -i` 模拟 launchd 的空环境）：直接跑 npm 得到
# `/bin/sh: npm: command not found`，**而且是静默失败**，
# 表现只会是「怎么没弹通知」。这与「index.ts 从来没调 loadEnv()」是同一类问题：
# launchd 是一条平时看不见的启动路径。
#
# 也不把 node 的绝对路径写进 plist：那会钉死具体版本号（当前 v24.15.0），
# nvm 一升级就断。这里改为 source nvm，用它的 default 别名（当前 lts/*）。

set -u

# 脚本自己所在的位置推导仓库根，这样仓库搬家也不用改 plist
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "── $(date '+%Y-%m-%d %H:%M:%S') 推送开始 ──"

# 优先用 nvm；没有就退回常见位置，最后才认现成的 PATH
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # nvm.sh 会引用未定义变量，临时关掉 set -u
  set +u
  . "$HOME/.nvm/nvm.sh"
  set -u
elif [ -x /opt/homebrew/bin/node ]; then
  PATH="/opt/homebrew/bin:$PATH"
elif [ -x /usr/local/bin/node ]; then
  PATH="/usr/local/bin:$PATH"
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "找不到 npm。launchd 不读 shell 配置，node 又是 nvm 装的——这条就是那个坑。"
  exit 1
fi

echo "node $(node -v)  在 $(command -v node)"
cd "$REPO" || { echo "进不去仓库目录：$REPO"; exit 1; }

# push 脚本不联网、不碰模型（ADR-0004），所以这里不需要任何代理设置
npm run push
status=$?
echo "── 退出码 $status ──"
exit $status
