# Quark

**Mode**: 🔐 Browser · **Domain**: `pan.quark.cn`

## Commands

| Command | Description |
|---------|-------------|
| `opencli quark list` | List files/folders |
| `opencli quark resolve <path>` | Resolve path to `file_id` |
| `opencli quark download` | Download file to local disk |
| `opencli quark upload <file>` | Upload local file to Quark |
| `opencli quark capacity` | Show total / used / available storage |
| `opencli quark save <share>` | Save files from a Quark share link to your drive |
| `opencli quark mkdir <path>` | Create a folder in Quark |
| `opencli quark rename` | Rename file/folder |
| `opencli quark move` | Move file/folder |
| `opencli quark delete` | Move file/folder to recycle bin |

## Requirements

- Browser Bridge extension
- A logged-in Quark Netdisk web session in Chrome (`https://pan.quark.cn/list#/list/all`)

## Health Check

```bash
# Browser bridge
opencli doctor

# Quark auth/session
opencli quark list --limit 1

# Quark capacity
opencli quark capacity
```

## Save Command

```bash
opencli quark save [options] <share>
```

- `share`: Quark share URL or `pwd_id`
- `--share-pwd`: Share password / extraction code
- `--source-path`: Optional path inside share, e.g. `/电影/演示.mp4`
- `--to-parent-file-id`: Destination parent folder `file_id`
- `--to-path`: Destination folder path from root (overrides `--to-parent-file-id`)
- `--overwrite`: Recycle same-name targets before saving

## Mkdir Command

```bash
opencli quark mkdir [options] <path>
```

- `path`: Folder path from root, e.g. `/Movies/2026`
- `--parents`: Create missing parent folders as needed

## Usage Examples

```bash
# List root
opencli quark list --limit 20

# Resolve path
opencli quark resolve "/电影/演示片"

# Show total / used / available capacity
opencli quark capacity

# Save root items from a share link
opencli quark save "https://pan.quark.cn/s/xxxxxxx"

# Save a specific path inside the share into a target folder
opencli quark save "https://pan.quark.cn/s/xxxxxxx" --share-pwd abcd --source-path "/电影/演示.mp4" --to-path "/转存"

# Create a folder in root
opencli quark mkdir "/电影"

# Create nested folders recursively
opencli quark mkdir "/电影/2026/科幻" --parents true

# Upload to root
opencli quark upload ./demo.mp4

# Upload to a folder path
opencli quark upload ./demo.mp4 --to-path "/电影/演示片"

# Download by path
opencli quark download --path "/电影/演示片/demo.mp4" --output ~/Downloads/test/ --overwrite

# Download by file_id
opencli quark download 1234567890abcdef --output ./downloads
```
