# AliPan

**Mode**: 🔐 Browser · **Domain**: `www.alipan.com`

## Commands

| Command | Description |
|---------|-------------|
| `opencli alipan list` | List files/folders |
| `opencli alipan resolve <path>` | Resolve path to `file_id` |
| `opencli alipan download` | Download file to local disk |
| `opencli alipan upload <file>` | Upload local file to AliPan |
| `opencli alipan capacity` | Show total / used / available storage |
| `opencli alipan save <share-link>` | Save files from a share link to your drive |
| `opencli alipan rename` | Rename file/folder |
| `opencli alipan move` | Move file/folder |
| `opencli alipan delete` | Move file/folder to recycle bin |

## Extra Dependencies (额外依赖)

- Browser Bridge extension (required for all AliPan commands)
- A logged-in AliPan web session in Chrome (`https://www.alipan.com/drive`)
- `yt-dlp` runtime (needed for some videos when direct download URL is empty)
  - OpenCLI will try `yt-dlp` first
  - If `yt-dlp` binary is broken, OpenCLI will automatically fallback to `python3 -m yt_dlp`

## Install / Repair Commands

```bash
# Option A: Homebrew
brew install yt-dlp
# if already installed but broken:
brew reinstall yt-dlp

# Option B: Python user install (recommended fallback)
python3 -m pip install --user -U yt-dlp certifi --break-system-packages
```

## Health Check

```bash
# Browser bridge
opencli doctor

# AliPan auth/session
opencli alipan list --limit 1

# AliPan capacity
opencli alipan capacity

# yt-dlp runtime (binary or python module)
yt-dlp --version || python3 -m yt_dlp --version
```

## Usage Examples

```bash
# List root
opencli alipan list --limit 20

# Resolve path
opencli alipan resolve "/电视/H 海贼王"

# Show total / used / available capacity
opencli alipan capacity

# Save root items from a share link
opencli alipan save "https://www.alipan.com/s/xxxxxxx"

# Save a specific path from a share link into a target folder
opencli alipan save "https://www.alipan.com/s/xxxxxxx" --share-pwd abcd --source-path "/电影/演示.mp4" --to-path "/转存"

# Upload to root
opencli alipan upload ./demo.mp4

# Upload to a folder path
opencli alipan upload ./demo.mp4 --to-path "/电视/H 海贼王"

# Upload with explicit remote name and overwrite on conflict
opencli alipan upload ./cover.jpg --to-path "/素材/封面" --name "cover.jpg" --check-name-mode overwrite

# Download by path
opencli alipan download --path "/电视/H 海贼王/demo.mp4" --output ~/Downloads/test/ --overwrite

# Download by file_id
opencli alipan download 69b81809647eba49ec4d4c1eaac1186056e4a481 --output ./downloads
```
