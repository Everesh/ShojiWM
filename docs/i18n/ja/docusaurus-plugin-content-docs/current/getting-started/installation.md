---
sidebar_position: 1
---

# インストール

ShojiWM は1つのスクリプト `dist/install.sh` でソースからインストールできます。
ビルド・コンポジターと TypeScript ランタイムのインストール・デフォルトのユーザー設定の
配置を行い、さらに Wayland セッションを登録するので、ログインマネージャーに ShojiWM が
表示されるようになります。

:::info[パッケージ版は準備中です]
ディストリビューション向けパッケージ（AUR など）は、**正式リリースの直前**に
登録する予定です。それまでは、下記の手順でソースからインストールしてください。
:::

## 前提条件

- 動作する Wayland / DRM 環境を備えた Linux システム
- 最近の Rust ツールチェーン（`cargo`）
- Node.js 18 以降（`npm` を含む）
- 以下のネイティブライブラリ（および開発用ヘッダー）。ShojiWM がリンクします。
  - `libwayland`
  - `libxkbcommon`
  - `libudev`
  - `libinput`
  - `libgbm`
  - `libseat`
  - `xwayland` —— Xwayland サーバー本体（下記の `xwayland-satellite` が利用します）
- [`xwayland-satellite`](https://github.com/Supreeeme/xwayland-satellite) ——
  X11 / Xwayland アプリの実行に必要（下記の注記参照）
- `sudo` —— インストーラーが `/usr` にファイルをコピーし、セッションを登録するため

:::note[ネイティブライブラリのインストール]
パッケージ名はディストリビューションによって異なります。例えば次のようになります。

```bash
# Debian / Ubuntu
sudo apt install libwayland-dev libxkbcommon-dev libudev-dev libinput-dev \
  libgbm-dev libseat-dev xwayland

# Arch Linux
sudo pacman -S wayland libxkbcommon systemd-libs libinput mesa seatd xorg-xwayland
```
:::

:::note[xwayland-satellite は必須です]
ShojiWM は X11 アプリの実行に `xwayland-satellite` を使用します。推奨は、リポジトリを
クローンして Cargo で直接インストールする方法です。

```bash
git clone https://github.com/Supreeeme/xwayland-satellite.git
cd xwayland-satellite
cargo install --path ./
```

これで `xwayland-satellite` バイナリが `PATH`（通常は `~/.cargo/bin`）に置かれます。
セッションを起動する前にインストールしておいてください。
:::

## インストール

```bash
git clone https://github.com/bea4dev/ShojiWM.git
cd ShojiWM
./dist/install.sh
```

システムディレクトリへのコピーが必要になると、スクリプトが `sudo` を要求します。
スクリプトは次のことを行います。

- コンポジターと xdg-desktop-portal バックエンドを**ビルド**し（`cargo`）、TypeScript
  ランタイムの依存関係をインストールします（`npm ci`）。
- コンポジターを `/usr/bin/shoji_wm` に、ランタイムを `/usr/lib/shojiwm` に
  インストールします。
- `~/.config/shojiwm` に**デフォルトのユーザー設定**を作成します（既存の設定はそのまま
  残されます）。
- **Wayland セッションエントリ**を登録するので、**ログインマネージャーに ShojiWM が
  表示されます** —— ログイン画面で選ぶだけです。
- ShojiWM の **xdg-desktop-portal** バックエンド（スクリーンキャストなど）を
  インストールします。

### インストールオプション

| フラグ | 効果 |
| --- | --- |
| `--no-build` | `cargo` / `npm` のビルドをスキップし、既存のバイナリを使う |
| `--no-portal` | xdg-desktop-portal バックエンドをインストールしない |
| `--no-config` | ユーザー設定の作成・更新を行わない |

`./dist/install.sh --help` でこの一覧を表示できます。

## 実行

- **ログインマネージャーから:** セッションとして **ShojiWM** を選んでログインします。
- **TTY から:** `shoji_wm --tty` を実行します。
- **開発（ネストしたウィンドウ）:** ソースツリーで
  `cargo run --release -p shoji_wm -- --dev` を実行します。現在のセッションを抜けずに
  反復開発できて便利です。

## オプション: デスクトップシェル

ShojiWM はコンポジター単体であり、バーやランチャーなどのシェル UI を自前では同梱して
いません。標準のシェル実装は別途提供されています。

- **shoji-bar-2** —— [github.com/bea4dev/shoji-bar-2](https://github.com/bea4dev/shoji-bar-2)

インストールと有効化の手順は、そのリポジトリの `README.md` を参照してください。
（ShojiWM のデフォルト設定は、`shoji-bar-2` が存在すれば自動的に起動します。）
