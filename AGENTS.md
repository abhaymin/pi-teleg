# Multi-Agent System for Telegram Bridge

> ⚠️ **FORCE RULE: MAIN POST ONLY**
> - ✅ ONLY download media that belongs to the main tweet being requested
> 
> **FORCE RULE: NO SCREENSHOT FALLBACK**
> **CRITICAL**: Never send screenshot.png as a fallback when no media is found.
> - ❌ DO NOT send screenshot.png as fallback when tweet has no images/videos
> - ❌ DO NOT send screenshot.png when main post has no media
> - ✅ Only send actual media files: jpg, png, gif, mp4, webm
> - ✅ If no actual media found, send text message only: "📭 No media in main post"
> - 📸 Screenshots are for archival reference only, NOT for Telegram delivery
> 
> **FORCE RULE: REDOWNLOAD IF NO ACTUAL MEDIA**
> **CRITICAL**: If a tweet only has screenshot.png with no actual media files (jpg, mp4, etc.), redownload to get the actual media.
> - ❌ DO NOT skip tweets that only have screenshots
> - ✅ ALWAYS attempt to download actual media (images/videos)
> - ✅ If download succeeds, replace screenshot with actual media files
> - ✅ If all download attempts fail, keep screenshot for reference (but don't send to Telegram)
> 
> **FORCE RULE: SKIP SUSPENDED/DELETED ACCOUNTS**
> **CRITICAL**: If a tweet page shows "suspended account" or "deleted" content, skip immediately.
> - ❌ DO NOT attempt to download from suspended accounts
> - ❌ DO NOT save screenshot for suspended/deleted content
> - ❌ DO NOT add to queue or log as failed - simply ignore
> - ✅ If page shows "This Post is from a suspended account" or similar - skip silently
> - ✅ If account is deleted or unavailable - ignore and move on
> - ✅ Archive only valid, accessible tweets with actual media
>
> **FORCE RULE: PROCESS AGE-RESTRICTED CONTENT**
> **CRITICAL**: Age-restricted content should be downloaded if possible. Do not skip or block.
> - ✅ DO NOT skip age-restricted tweets - attempt to download anyway
> - ✅ If age-restriction requires login, try to extract auth from browserOS session
> - ✅ Use chrome-devtools network inspection to find media URLs even when content is age-gated
> - ✅ Extract cookies/localStorage from browserOS to enable authenticated downloads
> - ✅ If direct download fails, try extracting auth tokens and using coded curl/ffmpeg
> - ✅ Only mark as "requires login" if all download methods are exhausted
> - ❌ DO NOT say "Age-restricted, cannot download" without trying auth extraction first
> - ❌ DO NOT give up on age-restricted content without attempting to bypass
>
> **ENFORCED RULE: CHECK FOR BOTH IMAGES AND VIDEOS**
> **CRITICAL**: When extracting media from a tweet, you MUST check for BOTH image AND video media:
> - ✅ Check `article img[src*="pbs.twimg.com/media"]` for images
> - ✅ Check `article video` elements for embedded videos
> - ✅ Videos can have `blob:` URLs or direct MP4 URLs
> - ✅ Videos have `poster` attribute with thumbnail image
> - ✅ A tweet with video will have `<video>` element inside the article
> - ❌ DO NOT only check for images - videos exist and must be detected
> - ❌ DO NOT assume no media if only images are not found
> - ✅ ALWAYS check both: `article.querySelectorAll('img, video')`
>
> **FORCE RULE: VALIDATE MEDIA PRESENCE IN ALL BROWSER MCP**
> **CRITICAL**: When using any browser MCP tool (browserOS, chrome-devtools, etc.), ALWAYS validate media presence:
> - ✅ When calling `get_page_content` or similar extraction tools, ALWAYS include `includeImages: true` parameter
> - ✅ When calling `get_page_content`, ALWAYS specify `selector: "img"` or `selector: "article"` to scope to main tweet
> - ✅ Verify extracted image URLs contain `pbs.twimg.com/media` before attempting download
> - ✅ For videos, verify `video` elements exist OR check network requests for `video.twimg.com` URLs
> - ✅ If extraction returns no media, DO NOT assume tweet has no media - re-check with different selector or method
> - ❌ DO NOT skip a tweet because one extraction method returned empty
> - ❌ DO NOT mark a tweet as "text-only" without verifying media is actually absent
> - ✅ Always cross-check: browserOS extract → chrome-devtools network → coded curl fallback
> - ✅ If in doubt, navigate to `/photo/1` or `/video/1` endpoints to force media loading
>
> **These rules are NON-NEGOTIABLE and enforced at every step of the download pipeline.**

## Deploy System (Extension + MCP Server)

This is a **monorepo** that deploys both the pi extension and an MCP server from the same source tree:

```
/home/abhaym/Development/PTGD/teleg/
├── src/extension/          # pi extension (TypeScript, builds to dist/)
├── mcp-server/             # Standalone MCP server (Node.js)
├── deploy.sh              # One-command deploy: extension + MCP server + settings
└── AGENTS.md              # This file
```

**To deploy:**
```bash
cd /home/abhaym/Development/PTGD/teleg
./deploy.sh
# Then restart pi from ANY directory
```

The deploy script:
1. Builds the extension TypeScript → `dist/index.js`
2. Installs MCP server dependencies
3. Updates `~/.pi/agent/settings.json` with extension + MCP packages
4. Updates `~/.pi/agent/mcp.json` with browser MCP configs

**What each part does:**
- **Extension** (`src/extension/`): Owns Telegram polling + message routing + @sessionName dispatch
- **MCP server** (`mcp-server/`): Provides `send_message`, `send_photo`, `send_video` tools via HTTP to ALL AI sessions (but only extension polls)

**Multi-session routing:**
- ALL sessions load both extension + MCP server
- Only the session with the polling lock handles incoming Telegram messages
- Messages prefixed with `@sessionName` route to that specific session
- Messages without prefix go to the primary session
- Each session shows its own name in the status bar (`teleg:teleg`, `teleg:pi-mem`)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                 teleg monorepo (single git repo)                     │
├─────────────────────────────────────────────────────────────────────┤
│  Extension (src/extension/)     │   MCP server (mcp-server/)        │
│  • Owns Telegram polling lock  │   • HTTP tools (no polling)        │
│  • Handles @sessionName routing│   • Works in ALL sessions          │
│  • Registers tools via pi API  │   • Shared config at ~/.pi/agent/ │
└──────────────┬──────────────────┴────────────────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│ ~/.pi/agent/settings.json                                           │
│   packages: [".../teleg/src/extension", ".../teleg/mcp-server"]    │
└─────────────────────────────────────────────────────────────────────┘
```

**All agents run on local models (qwen3.6/llamacpp1) for safe, private processing.**

## Agent Definitions

### Model Configuration (Local llama.cpp)

**Primary Models** (Use in priority order):
1. `qwen3.6` - Main reasoning agent (direct llamacpp)
2. `qwen3.6:30b` - Complex task handling
3. `llamacpp1` - Direct llama.cpp inference

**Model Configuration**:
```yaml
models:
  qwen: "qwen3.6"                          # Qwen3.6B (GGUF via llamacpp)
  qwen_large: "qwen3.6:30b"                # Larger variant
  llama: "llamacpp1"                        # Direct llama.cpp

# For pi-subagents model configuration:
model: "qwen3.6"        # Default - local, private
model: "qwen3.6:30b"   # Complex tasks
model: "llamacpp1"     # Direct llama.cpp
```

**Why Local Models?**
- ✅ No data sent to external APIs (privacy)
- ✅ Safe content processing
- ✅ Offline capability
- ✅ No API rate limits
- ✅ Full control over processing

---

### 1. Twitter/X Download Agent
- **Purpose**: Detect and download content from Twitter/X posts
- **Trigger**: Any Tweet or X.com URL in messages
- **Method**: Uses `browserOS` MCP tools with auth session + `chrome-devtools` for network extraction
- **Tools**:
  - `browserOS.navigate` / `browserOS.new_page` - Open tweet URL (has auth)
  - `browserOS.wait_for_selector` - Wait for page to load
  - `browserOS.screenshot` - Capture tweet content
  - `browserOS.extract_text` - Extract tweet text
  - `chrome-devtools.list_network_requests` - Extract actual media URLs from network tab
- **Download Method** (in priority order):
  1. **browserOS evaluate_script**: Navigate to tweet, extract `article video source` or `article img[src*="media"]` URLs
  2. **curl with browserOS-extracted auth**: Extract cookies from browserOS session, use coded curl for direct download
  3. **yt-dlp --cookies-from-browser chrome** (if available): Reliable fallback, especially for age-restricted content
  4. **chrome-devtools network tab**: Find `video.twimg.com` or `pbs.twimg.com/media` URLs as last resort
- **Key**: browserOS has auth session; curl with extracted auth works on all machines; yt-dlp is a convenience fallback

### 1.5 Coded Download (Fallback with Auth)
- **Purpose**: Direct HTTP download when browserOS extraction fails
- **Trigger**: browserOS MCP returns error or empty media URLs
- **Auth Extraction**: Use `browseros_evaluate_script` to get cookies/tokens from browser context:
  ```javascript
  // Extract auth cookies for Twitter
  document.cookie  // Read HTTP-only cookies
  // Get Bearer token from localStorage
  localStorage.getItem('guest_id')
  localStorage.getItem('ct0')  // CSRF token
  // Get authorization header from fetch interceptors
  // Extract from window.__NEXUS_STATE__ or similar
  ```
- **Coded Download Script** (Python/bash) — Use extracted auth with curl as primary:
  ```bash
  # PRIMARY: curl with auth headers (works on all machines)
  curl -L -o "{output_path}" \
    -H "Authorization: Bearer {bearer_token}" \
    -H "Cookie: guest_id={guest}; ct0={csrf}" \
    "{media_url}"

  # FALLBACK: yt-dlp with browser cookies (if available, better for age-restricted)
  yt-dlp --cookies-from-browser chrome \
    -o "{output_path}" "{tweet_url}"
  ```
- **Tools for extraction**:
  - `browseros_evaluate_script` - Extract cookies/localStorage from active session
  - `bash` - Run coded download commands (curl, wget, yt-dlp)
- **Priority**:
  1. browserOS navigate + evaluate_script (detect media type and URL)
  2. curl with browserOS-extracted auth cookies (works on all machines)
  3. yt-dlp --cookies-from-browser chrome (if available, better for age-restricted)
  4. chrome-devtools network inspection for direct URLs
- **⚠️ Age-restricted tweets**: Try curl with auth first. If that fails and yt-dlp is available, use yt-dlp. Direct URL curls to `video.twimg.com` often fail for age-gated content even with auth.

### 2. Browser Agent (browserOS)
- **Purpose**: Web navigation, scraping, and media capture
- **Server**: `browserOS` MCP
- **Tools**: Full browser automation (66 tools available)
- **Fallback**: `agent-browser` skill for additional browser operations
- **CRITICAL**: Always wait for page to load before extraction
  - Use `wait_for_selector` after navigation
  - Verify content is visible before extracting data
  - Check for loading spinners/elements to disappear

### 3. Archive Agent
- **Purpose**: Save downloaded content to local storage
- **Location**: `/home/abhaym/Development/PTGD/teleg/archive/`
- **Action**: After any download, automatically archive to:
  ```
  /home/abhaym/Development/PTGD/teleg/archive/
  ├── tweets/
  │   ├── {tweet_id}/
  │   │   ├── content.txt
  │   │   ├── media/
  │   │   └── screenshot.png
  ├── downloads/
  │   └── {timestamp}_{original_filename}
  └── logs/
      └── archive.log
  ```

### 4. Notification Agent
- **Purpose**: Send completion confirmation with media back to Telegram
- **Response Format**: Text summary + media attachments (images first, then videos)
- **Template**: 
  ```
  ✅ Downloaded & Archived
  
  📝 {tweet_text}
  👤 {author}
  🆔 {tweet_id}
  📁 /archive/tweets/{tweet_id}/
  
  [Media: images, then videos as attachments]
  ```
- **Attachment Order**: Images first (with progress like "1/4"), then videos
- **Fallback**: Send screenshot if no media found

## Workflow: Tweet/X Download Process

```
                    ┌─────────────────────────────────────┐
                    │         MULTI-MCP APPROACH          │
                    │   browserOS (auth) + chrome-devtools │
                    │        (network extraction)         │
                    └───────────────┬─────────────────────┘
                                    │
[Tweet URL Detected]                    │
         │                            ▼
         ▼         ┌─────────────────────────────────────┐
┌─────────────────────┐    │  browserOS + chrome-devtools     │
│  browserOS Navigate │    │  Combined Workflow:              │
│  (auth session)    │    │  1. browserOS navigate to URL    │
└─────────┬───────────┘    │  2. Wait for page load          │
          │              │  3. chrome-devtools network tab  │
          │              │     extracts media URLs          │
          ▼              │  4. curl/ffmpeg download         │
┌─────────────────────┐    └───────────────┬───────────────┘
│  Extract Media URL  │                     │
│  via network tab     │                     ▼
└─────────┬───────────┘    ┌─────────────────────────────────────┐
          │                │  For Videos:                        │
          ▼                │  • Find .m3u8 playlist in network   │
┌─────────────────────┐    │  • ffmpeg -i "playlist.m3u8" video.mp4 │
│  Download Media      │    └───────────────┬─────────────────────┘
│  • curl for images   │                     │
│  • ffmpeg for video  │                     ▼
└─────────┬───────────┘    ┌─────────────────────────────────────┐
          │                │  Archive + Notify                    │
          ▼                └─────────────────────────────────────┘
```

**Why combined approach:**
- browserOS: Has authentication session (logged in user)
- chrome-devtools: Shows actual network requests with media URLs
- Together: Auth + URL extraction = working downloads

## Implementation Using pi-subagents

### Chain Definition (pi-subagents format)

```yaml
chains:
  tweet-download:
    name: "Tweet/X Download Pipeline"
    steps:
      - agent: "twitter-agent"
        task: |
          Navigate to {tweet_url} using browserOS.
          WAIT for page to fully load before proceeding.
          
          # ⚠️ FORCE RULE: MAIN POST MEDIA ONLY
          # ONLY extract and download media from the main tweet at the URL.
          # DO NOT download any media from:
          #   - Replies to the tweet
          #   - Threaded replies
          #   - Quoted tweets
          #   - "Show more replies" expansions
          #   - Any other content on the page
          #
          # Steps:
          # 1. Locate the main tweet article element (article[data-testid="tweet"])
          # 2. Extract tweet text, author, timestamp from MAIN TWEET ONLY
          # 3. Extract media URLs ONLY from the main tweet article
          # 4. REJECT any media outside the main tweet article
          # 5. Scroll within main tweet only if needed for lazy loading
          #
          # Verify: All extracted media must belong to the main tweet.
          
          Extract tweet text, author, timestamp, and media URLs ONLY after content is visible.
          # ATTEMPT 1: Try browserOS direct download
          Try to download media using browserOS tools.
      - agent: "download-agent"
        task: |
          Wait for downloads to complete.
          Verify all files are saved before archiving.
      - agent: "download-agent"
        task: |
          Download all media from {previous} to /home/abhaym/Development/PTGD/teleg/archive/tweets/{tweet_id}/
          Save tweet content as content.json
      # FALLBACK: If previous step failed, try curl with auth, then yt-dlp if available
      - agent: "coded-download-agent"
        task: |
          IF {previous.media_urls} is empty OR download failed:
            1. Extract auth from browserOS session:
               - Execute browseros_evaluate_script to get cookies/localStorage
            2. Try curl with auth headers first (works on all machines):
               curl -L -o "{output_path}" \
                 -H "Authorization: Bearer {bearer}" \
                 -H "Cookie: guest_id={guest}; ct0={csrf}" \
                 "{media_url}"
            3. If curl fails and yt-dlp is available, use yt-dlp with browser cookies:
               yt-dlp --cookies-from-browser chrome \
                 -o "{archive_path}%(title)s.%(ext)s" \
                 "{tweet_url}"
            4. Verify download before archiving.
          ELSE: Skip this step (already have media from previous)
      - agent: "archive-agent"
        task: |
          Log the download action to /home/abhaym/Development/PTGD/teleg/archive/logs/archive.log
          Format: {timestamp} | {tweet_id} | {media_count} files | {status} | {method}
          Note: Method should be 'browserOS', 'coded-curl', 'coded-yt-dlp', or 'public-fallback'
      - agent: "notify-agent"
        task: |
          Send confirmation: "✅ Downloaded and archived tweet {tweet_id}"
          If fallback method used, note: "(via {method})"
```

### Agent Configuration

```yaml
agents:
  twitter-agent:
    description: "Twitter/X content extraction"
    model: "qwen3.6"              # Local model - privacy safe
    skills: ["browserOS"]
    tools: ["browserOS"]
    # Fallback models if qwen3.6 unavailable:
    fallback_model: "llamacpp1"

  download-agent:
    description: "Media download and file management"
    model: "qwen3.6"
    tools: ["bash"]

  coded-download-agent:
    description: "Coded HTTP download with auth cookies (fallback when browserOS fails)"
    model: "qwen3.6"
    tools: ["bash", "browserOS"]  # Needs browserOS to extract cookies first
    # Auth extraction script templates
    auth_extraction:
      cookies: |
        // Get Twitter auth cookies from browser
        document.cookie.split('; ').reduce((acc, c) => {
          const [k, v] = c.split('=');
          acc[k] = v;
          return acc;
        }, {});
      localStorage: |
        // Get Twitter tokens from localStorage
        ({
          guest_id: localStorage.getItem('guest_id'),
          ct0: localStorage.getItem('ct0'),
          auth_token: localStorage.getItem('auth_token'),
        })
      bearer: |
        // Extract Bearer token from page (usually in page source)
        // Check meta tags, scripts, or window objects
        document.querySelector('meta[name="twitter:site"]')?.content || '';

  archive-agent:
    description: "Local file archiving"
    model: "qwen3.6"
    tools: ["bash"]

  notify-agent:
    description: "Telegram completion notifications"
    model: "qwen3.6"
    tools: ["bash"]
```

### Safe Download Model (Direct llama.cpp)

All agents use direct llama.cpp for safe content handling:

```yaml
safe_download:
  enabled: true
  models:
    primary: "qwen3.6"           # Fast, private inference
    complex: "qwen3.6:30b"       # For video/large media
    fallback: "llamacpp1"        # Direct llama.cpp
  
  # llama.cpp direct configuration
  llamacpp:
    model_path: "~/.cache/llama.cpp/models/"
    binary_path: "/usr/local/bin/llama-cli"
    n_ctx: 4096
    n_gpu_layers: -1  # All to GPU
    temperature: 0.3
```

**Security Benefits**:
- Content never leaves local machine
- Tweet data processed locally
- Media URLs resolved locally
- No external API exposure

## Usage Examples

### Example 1: Single Tweet Download
```
User sends: "https://x.com/user/status/123456789"
→ Twitter Agent navigates to URL
→ Extracts tweet content and media
→ Downloads to /home/abhaym/Development/PTGD/teleg/archive/tweets/123456789/
→ Confirms via Telegram
```

### Example 2: Multiple Tweets (List of Links)
```
User sends: Multiple X.com links (one per line, or comma-separated):
https://x.com/user/status/123456789
https://x.com/user/status/987654321
https://x.com/another/status/555555555

OR single message with multiple URLs:
"Check these tweets: https://x.com/user/status/123456789, https://x.com/user/status/987654321"

→ Parse all URLs from message
→ Add each to download queue
→ Process in parallel (up to MAX_PARALLEL_DOWNLOADS)
→ Archive each separately
→ Send combined summary with individual results
```

### Example 3: Media-Only Download
```
User sends: "Download the video from this tweet: x.com/..."
→ Navigate to tweet
→ Extract video URL
→ Download video to /home/abhaym/Development/PTGD/teleg/archive/downloads/
→ Send local file path confirmation
```

### Multiple Links Processing

**Supported Input Formats**:
```
Format 1: Newline-separated URLs
https://x.com/user/status/123456789
https://x.com/user/status/987654321
https://x.com/another/status/555555555

Format 2: Comma-separated URLs
https://x.com/user/status/123456789, https://x.com/user/status/987654321

Format 3: Mixed (newline + inline text)
"Hey check these tweets:\nhttps://x.com/user/status/123456789\nAnd this one: https://x.com/user/status/987654321"

Format 4: List with bullet points
- https://x.com/user/status/123456789
- https://x.com/user/status/987654321

Format 5: Numbered list
1. https://x.com/user/status/123456789
2. https://x.com/user/status/987654321
```

**URL Extraction Logic**:
```javascript
// Extract ALL Twitter/X URLs from any text format
function extractAllTwitterUrls(text) {
  // Match both x.com and twitter.com domains
  const urlPattern = /https?:\/\/(?:x|twitter)\.com\/[^\s<>"]+\/status\/\d+/gi;
  const matches = text.match(urlPattern) || [];
  // Deduplicate while preserving order
  return [...new Set(matches)];
}

// Example usage:
const text = `Check these tweets:
https://x.com/user1/status/111
And also: https://x.com/user2/status/222`;
const urls = extractAllTwitterUrls(text);
// Result: ['https://x.com/user1/status/111', 'https://x.com/user2/status/222']
```

**Batch Processing Rules**:
- Parse ALL URLs from a single message
- Validate each URL format before processing
- Track individual status for each URL
- Process up to `MAX_PARALLEL_DOWNLOADS` concurrently
- Report individual results (success/failure per URL)
- Anti-spam: Rate limit batch requests


**Telegram Response for Multiple Links**:
```
📥 Batch Download Started (3 tweets)

1️⃣ 123456789 - Processing...
2️⃣ 987654321 - Processing...
3️⃣ 555555555 - Processing...

[Then sends media from each tweet sequentially:]

✅ 123456789
📝 Tweet text from first post...
👤 @user1
🖼️ image1.jpg (1/2)
🖼️ image2.jpg (2/2)

✅ 987654321
📝 Tweet text from second post...
👤 @user2
🎬 video1.mp4 (1/1)

🔄 555555555 - No media found, redownloading...
```

**Key Behavior for Multiple Links**:
- Each tweet is processed one at a time (sequential, not parallel)
- Media from each tweet is sent immediately after that tweet is ready
- Tweets with archived media are sent first
- **FORCE RULE: Redownload if no actual media** - If tweet only has screenshot, trigger redownload
- Tweets being downloaded show "downloading" then send media when complete
- 300ms delay between tweets to respect rate limits
- Main post media only (FORCE RULE applies to each tweet)
- **NO SCREENSHOTS SENT** - Only actual media files (jpg, mp4, etc.)
```
User sends: "Download the video from this tweet: x.com/..."
→ Navigate to tweet
→ Extract video URL
→ Download video to /home/abhaym/Development/PTGD/teleg/archive/downloads/
→ Send local file path confirmation
```

## MCP Server Configuration

### browserOS (Primary)
- **Connection**: MCP gateway
- **Tools Used**: 
  - `navigate`, `screenshot`, `click`, `type`
  - `download_file`, `extract_text`, `get_page_info`
  - `wait_for_selector`, `scroll`, `switch_frame`
- **Fallback**: `agent-browser` skill

### agent-browser (Fallback)
- **Skills**: Playwright-based browser automation
- **Trigger**: When browserOS tools are insufficient

## File Structure After Downloads

```
/home/abhaym/Development/PTGD/teleg/
├── AGENTS.md                    ← This file
├── archive/
│   ├── tweets/
│   │   ├── 123456789/
│   │   │   ├── content.json
│   │   │   ├── media/
│   │   │   │   ├── image1.jpg
│   │   │   │   └── video.mp4
│   │   │   └── screenshot.png
│   │   └── 987654321/
│   │       └── ...
│   ├── downloads/
│   │   ├── 2024-05-08_123456_image.png
│   │   └── ...
│   └── logs/
│       └── archive.log
├── src/
│   └── ...
└── ...
```

## Crash-Recoverable Queue System

A persistent queue system ensures all requests are processed even if pi crashes and restarts.

### Architecture

```
[Telegram URL] → queue.json (persistent) → processor → archive → Telegram response
                      ↑                                          ↓
                      └──────────── RESTART RECOVERY ─────────────┘
```

**Key Features:**
- Queue stored in `/archive/queue.json` - survives crashes
- Atomic file writes prevent corruption
- Automatic recovery of "stuck" items on restart
- Retry logic with max attempts

### Queue File Structure

```json
{
  "version": 1,
  "queue": [
    {
      "id": 1747200000000,
      "tweet_id": "2054575487540944911",
      "url": "https://x.com/user/status/2054575487540944911",
      "status": "pending|processing|failed",
      "added_at": "2026-05-14T10:30:00.000Z",
      "retry_count": 0,
      "last_error": null
    }
  ],
  "processed": [...],
  "failed": [...],
  "last_updated": "2026-05-14T10:30:00.000Z"
}
```

### Queue Manager Commands

```bash
# Add single tweet to queue
node /archive/queue-manager.js add <url>

# Add multiple tweets
node /archive/queue-manager.js add-multi <url1> <url2> ...

# Get next item to process (for scripts)
node /archive/queue-manager.js process

# Show queue status
node /archive/queue-manager.js status

# List all items
node /archive/queue-manager.js list

# Retry failed items
node /archive/queue-manager.js retry-failed

# Clean old processed (keeps last 100)
node /archive/queue-manager.js clean
```

### Shell Helpers

```bash
# Add to queue (wrapper script)
./archive/queue-add.sh <url> [url2] ...

# Run queue processor (daemon mode)
./archive/queue-runner.sh
```

### Crash Recovery Flow

1. **On crash:** Queue persists in `queue.json`
2. **On restart:** Check for items stuck in "processing" state
3. **Recovery:** Reset stuck items to "pending" for retry
4. **Continue:** Process remaining queue items sequentially

```javascript
// Recovery on startup
const queue = loadQueue();
queue.queue.forEach(item => {
  if (item.status === 'processing') {
    item.status = 'pending';  // Reset stuck items
    delete item.started_at;
  }
});
saveQueue(queue);
```

### Integration Example

```javascript
// When Telegram message received:
async function onTelegramMessage(msg) {
  const urls = extractAllTwitterUrls(msg.text);
  
  for (const url of urls) {
    // Add to persistent queue
    execSync(`node /archive/queue-manager.js add "${url}"`);
  }
  
  // Immediately process (pi handles crash recovery via queue)
  processQueue();
}
```

---

## Configuration Variables

```bash
# Local project path
PROJECT_ROOT="/home/abhaym/Development/PTGD/teleg"

# Archive directory (absolute path)
ARCHIVE_DIR="/home/abhaym/Development/PTGD/teleg/archive"

# Queue file (persistent, crash-safe)
QUEUE_FILE="/home/abhaym/Development/PTGD/teleg/archive/queue.json"

# Tweet storage subdirectory
TWEET_DIR="/home/abhaym/Development/PTGD/teleg/archive/tweets"

# Download storage subdirectory  
DOWNLOAD_DIR="/home/abhaym/Development/PTGD/teleg/archive/downloads"

# Log file location
LOG_FILE="/home/abhaym/Development/PTGD/teleg/archive/logs/archive.log"

# Maximum concurrent downloads
MAX_CONCURRENT=3

# Download timeout (seconds)
DOWNLOAD_TIMEOUT=300

# Queue settings
QUEUE_MAX_RETRIES=3
QUEUE_POLL_INTERVAL=2

# Auth cookie file for coded downloads (extracted from browserOS)
AUTH_COOKIE_FILE="/home/abhaym/Development/PTGD/teleg/archive/.auth_cookies.json"

# Bearer token storage for coded downloads
BEARER_TOKEN_FILE="/home/abhaym/Development/PTGD/teleg/archive/.bearer_token.txt"

# Fallback download tools priority
FALLBACK_TOOLS="curl,browserOS,yt-dlp"  # Order: curl-with-auth (guaranteed), browserOS, yt-dlp (optional)

# Telegram bot settings
TELEGRAM_BOT_TOKEN="your_bot_token_here"
TELEGRAM_CHAT_ID="your_chat_id_here"

# Anti-spam: cooldown between resends (milliseconds)
RESEND_COOLDOWN_MS=30000  # 30 seconds

# Batch download settings
MAX_URLS_PER_MESSAGE=20   # Max URLs to process from single message
MAX_BATCH_CONCURRENT=3    # Max concurrent downloads in batch mode
BATCH_DELAY_MS=500       # Delay between processing each URL
```

## Multi-Agent Workflow (pi-subagents)

To implement this multi-agent system, use the `pi-subagents` skill:

```javascript
// Example: Initialize chain with coded download fallback
subagent({
  action: "create",
  config: {
    name: "twitter-download-chain",
    chain: [
      { 
        agent: "browser-scout", 
        task: "Navigate to {url} and extract tweet data, try browserOS download"
      },
      { 
        agent: "media-downloader", 
        task: "Process {previous.media_urls}, archive downloaded content"
      },
      { 
        // FALLBACK: If media download failed, use coded method with auth
        agent: "coded-download",
        task: "IF {previous.success} == false OR media_empty: " +
              "  1. Extract auth from browserOS (cookies, localStorage, Bearer)" +
              "  2. Run coded download (curl/yt-dlp) with auth headers" +
              "  3. Verify and archive"
      },
      { 
        agent: "notifier", 
        task: "Confirm completion via Telegram (note method used if fallback)"
      }
    ]
  }
})
```

## Subagent Integration in Teleg Extension

The teleg extension should delegate tweet downloads to subagents rather than doing them inline. This allows:
- Multiple tweets to be processed concurrently
- Background processing while the agent continues other work
- Better error handling and retry logic
- Crash recovery via persistent queue

### Integration Pattern

```typescript
// In extension/index.ts - when a Telegram message contains Twitter URLs:

import { subagent } from 'pi-subagents';

async function handleTelegramMessage(msg, ctx) {
  const urls = extractAllTwitterUrls(msg.text);
  
  if (urls.length === 0) return;
  
  if (urls.length === 1) {
    // Single tweet: launch async subagent chain
    const run = await subagent({
      chain: [
        { 
          agent: "twitter-download-agent", 
          task: `Download tweet from {url}, archive to /home/abhaym/Development/PTGD/teleg/archive/tweets/`,
          model: "minimax/MiniMax-M2.7"
        }
      ],
      async: true  // Don't block - process in background
    });
  } else {
    // Multiple tweets: launch parallel subagents (up to MAX_CONCURRENT)
    const tasks = urls.map((url, idx) => ({
      agent: "twitter-download-agent",
      task: `Download tweet from {url}, archive to /home/abhaym/Development/PTGD/teleg/archive/tweets/`,
      output: `/tmp/tweet-download-${Date.now()}-${idx}.json`,
      progress: true
    }));
    
    await subagent({
      tasks,
      concurrency: 3,  // Max parallel downloads
      async: true
    });
  }
}
```

### Twitter Download Agent (pi-subagents chain)

Create a chain file at `.pi/chains/tweet-download.chain.md`:

```markdown
---
name: tweet-download
description: Download and archive a tweet with media
steps:
  - agent: browser-scout
    task: |
      Navigate to {url} using browserOS MCP tools.
      CRITICAL: Only extract from the MAIN tweet at the URL.
      DO NOT download media from replies, threads, quoted tweets, or "more replies".
      
      Steps:
      1. Open new browserOS page with the tweet URL
      2. Wait for page to fully load (use take_snapshot to verify)
      3. Find the main tweet article (article[data-testid="tweet"])
      4. Extract tweet text, author, timestamp from the MAIN article ONLY
      5. Find media elements (img, video) INSIDE the main article ONLY
      6. If no media found in main article, return { media_urls: [], has_media: false }
      7. Download media using browserOS download or coded curl
      8. Archive to /home/abhaym/Development/PTGD/teleg/archive/tweets/{tweet_id}/
      9. Save content.json and media files
      10. Use telegram-bridge tools to notify on completion

  - agent: media-verifier
    task: |
      Verify the download completed successfully.
      Check /home/abhaym/Development/PTGD/teleg/archive/tweets/{tweet_id}/media/
      Confirm at least one actual media file exists (jpg, mp4, etc).
      If only screenshot exists but no actual media, mark for redownload.

  - agent: telegram-notifier
    task: |
      Send completion message via telegram-bridge MCP.
      Include tweet summary and media attachments.
      Report any issues encountered during download.
```

### Agent Definitions (for pi-subagents)

Create agents at `.pi/agents/` directory:

**`.pi/agents/twitter-download-agent.md`:**
```markdown
---
name: twitter-download-agent
description: Download a tweet's media and archive it
model: minimax/MiniMax-M2.7
skills: [browserOS]
tools: [bash, mcp]

# CRITICAL: ONLY download main post media
# DO NOT download from replies, threads, quoted tweets, or "more replies"

extraction_rules:
  main_post_only: true
  verify_before_download: true

steps:
  1. Navigate to {url} via browserOS
  2. Wait for page load (take_snapshot)
  3. Find main tweet article
  4. Extract media URLs from main article only
  5. Download media with browserOS or coded curl
  6. Archive to /home/abhaym/Development/PTGD/teleg/archive/tweets/{tweet_id}/
  7. Send Telegram notification via MCP
```

**`.pi/agents/browser-scout.md`:**
```markdown
---
name: browser-scout
description: Navigate and extract tweet data via browserOS
model: minimax/MiniMax-M2.7
skills: [browserOS]
tools: [mcp]

task_template: |
  Navigate to {url} using browserOS.
  
  CRITICAL RULES:
  - ONLY extract from the MAIN tweet article at the URL
  - DO NOT extract media from replies, threads, or quoted tweets
  - Locate: article[data-testid="tweet"] - this is the main tweet
  - Media must be inside the main tweet article to be valid
  
  Extraction:
  1. Open page: browserOS.new_page with url
  2. Wait: take_snapshot to verify content loaded
  3. Find main article: document.querySelector('article[data-testid="tweet"]')
  4. Get text: article.querySelector('[data-testid="tweetText"]')?.innerText
  5. Get media: article.querySelectorAll('img[src*="media"]')
  6. If no media in main article, return empty media_urls
  7. Download media to /home/abhaym/Development/PTGD/teleg/archive/tweets/{tweet_id}/media/
  8. Save content.json with tweet metadata

output: |
  {
    tweet_id: string,
    text: string,
    author: string,
    media_urls: string[],
    has_media: boolean,
    archive_path: string
  }
```

**`.pi/agents/telegram-notifier.md`:**
```markdown
---
name: telegram-notifier
description: Send Telegram notifications via telegram-bridge MCP
model: minimax/MiniMax-M2.7
tools: [mcp]

task_template: |
  Send a tweet result notification to Telegram.
  
  Use these MCP tools:
  - telegram_bridge_send_message: Send text summary
  - telegram_bridge_send_photo: Send image with caption
  - telegram_bridge_send_video: Send video with caption
  
  Format:
  ✅ Downloaded & Archived
  📝 {tweet_text}
  👤 {author}
  🆔 {tweet_id}
  
  Then attach media files (images first, then videos).
  Rate limit: 300ms between messages.
  
  If no media found:
  📭 No media in main post

output: |
  { success: boolean, message_id: number }
```

## Parallel Multi-Agent Downloading (Queue System)

When multiple tweets are queued from Telegram, use parallel subagents to download concurrently.

### Queue Architecture

```
[Telegram Messages with URLs]
           │
           ▼
┌─────────────────────────────┐
│      URL Queue File         │
│  /archive/pending_queue.json │
│  [{"id":1,"url":"..."},   │
│   {"id":2,"url":"..."}]    │
└─────────────┬───────────────┘
              │
              ▼
    ┌─────────┴─────────┐
    ▼                   ▼
┌────────────┐   ┌────────────┐
│ Subagent 1 │   │ Subagent 2 │  ← Parallel workers (configurable count)
│ (Tweet ID) │   │ (Tweet ID) │
└─────┬──────┘   └─────┬──────┘
      │                │
      ▼                ▼
┌────────────┐   ┌────────────┐
│ Download  │   │ Download   │
│ & Archive │   │ & Archive │
└─────┬──────┘   └─────┬──────┘
      │                │
      └────────┬───────┘
               ▼
    ┌──────────────────┐
    │  Archive Complete │
    │  Notify Telegram  │
    └──────────────────┘
```

### Queue Configuration

```bash
# Queue file location
QUEUE_FILE="/home/abhaym/Development/PTGD/teleg/archive/pending_queue.json"

# Max parallel downloads (don't overload browserOS)
MAX_PARALLEL_DOWNLOADS=2

# Max subagents running concurrently
MAX_CONCURRENT_SUBAGENTS=2

# Queue polling interval (seconds)
QUEUE_POLL_INTERVAL=5

# BrowserOS page pool size (for parallel navigation)
BROWSEROS_PAGE_POOL=3
```

### Pi-Subagents Parallel Execution

```javascript
// Process queue with parallel subagents
async function processTweetQueue() {
  const queue = JSON.parse(readFile(QUEUE_FILE));
  const pending = queue.filter(item => item.status === 'pending');
  
  // Process up to MAX_PARALLEL_DOWNLOADS in parallel
  const batch = pending.slice(0, MAX_PARALLEL_DOWNLOADS);
  
  // Launch parallel subagent tasks
  subagent({
    tasks: batch.map(item => ({
      agent: "twitter-download-agent",
      task: `Download tweet from {item.url}, archive to /home/abhaym/Development/PTGD/teleg/archive/tweets/{item.tweet_id}/`,
      output: `/home/abhaym/Development/PTGD/teleg/archive/results/${item.id}.json`
    })),
    concurrency: MAX_CONCURRENT_SUBAGENTS
  });
}

// Or use worktree mode for isolation
subagent({
  tasks: batch.map(item => ({
    agent: "twitter-download-agent",
    task: `Download {item.url}`
  })),
  concurrency: MAX_CONCURRENT_SUBAGENTS,
  worktree: true  // Isolated git worktrees per download
});
```

### Queue File Format

```json
{
  "queue": [
    {
      "id": 1,
      "tweet_id": "2054575487540944911",
      "url": "https://x.com/potato2307/status/2054575487540944911",
      "status": "pending",
      "added_at": "2026-05-14T00:30:00Z"
    },
    {
      "id": 2,
      "tweet_id": "2054196890254614937",
      "url": "https://x.com/NWilliams18583/status/2054196890254614937",
      "status": "completed",
      "completed_at": "2026-05-14T00:25:00Z",
      "method": "browserOS+coded-curl"
    }
  ]
}
```

### Twitter Download Agent (Subagent)

```yaml
agents:
  twitter-download-agent:
    description: "Download and archive a single tweet (main post ONLY - FORCE RULE)"
    model: "qwen3.6"
    tools: ["browserOS", "bash"]
    defaultContext: "fork"
    # ⚠️ FORCE RULE: ONLY download main post media
    extraction_rules:
      main_post_only: true
      exclude:
        - "replies"
        - "threaded_replies"
        - "quoted_tweets"
        - "more_replies_expansion"
        - "any_other_content"
    steps:
      - Navigate to {url} via browserOS
      - Wait for page load
      # ⚠️ CRITICAL: Only extract from the main tweet article, ignore all other elements
      - Identify the main tweet article element (article[data-tweet-id])
      - Extract main tweet content + media ONLY from the main tweet article
      - REJECT any media found in: replies, threads, quoted tweets, "more replies"
      - Verify extracted media belongs to main tweet before proceeding
      - Scroll if needed to load lazy media in the MAIN TWEET ONLY
      - Download media via coded methods if browserOS fails
      - Archive to /home/abhaym/Development/PTGD/teleg/archive/tweets/{tweet_id}/
      - Log to /home/abhaym/Development/PTGD/teleg/archive/logs/archive.log
      - Send Telegram confirmation
```

### Queue Management Commands

```bash
# Add URL to queue
add_to_queue() {
  local url=$1
  local tweet_id=$(echo "$url" | grep -oP 'status/\K\d+')
  jq ".queue += [{\"id\": now, \"tweet_id\": \"$tweet_id\", \"url\": \"$url\", \"status\": \"pending\", \"added_at\": now}]" \
    "$QUEUE_FILE" > "${QUEUE_FILE}.tmp" && mv "${QUEUE_FILE}.tmp" "$QUEUE_FILE"
}

# Mark queue item complete
complete_queue_item() {
  local id=$1
  local method=$2
  jq ".queue[] | select(.id == $id) | .status = \"completed\" | .completed_at = now | .method = \"$method\"" \
    "$QUEUE_FILE" > "${QUEUE_FILE}.tmp" && mv "${QUEUE_FILE}.tmp" "$QUEUE_FILE"
}

# Check pending count
pending_count() {
  jq '[.queue[] | select(.status == "pending")] | length' "$QUEUE_FILE"
}
```

### Integration with Telegram Bot

```javascript
// On Telegram message with X.com URLs - SUPPORTS MULTIPLE URLs PER MESSAGE
function onTelegramMessage(msg) {
  try {
    // Validate input first
    if (!msg || !msg.text) {
      console.error('Invalid message object');
      return;
    }
    
    // Extract ALL Twitter/X URLs from message (supports any format)
    const urls = extractAllTwitterUrls(msg.text);
    if (!urls || urls.length === 0) {
      return;  // No URLs, nothing to do
    }
    
    // Handle multiple URLs
    if (urls.length > 1) {
      return handleMultipleUrls(msg, urls);
    }
    
    // Single URL - process normally
    return handleSingleUrl(msg, urls[0]);
    
  } catch (err) {
    console.error('Telegram message handler crashed:', err);
    sendMessage(msg?.chat_id, '⚠️ Handler error, please retry').catch(() => {});
  }
}

// Extract ALL Twitter/X URLs from any text format
function extractAllTwitterUrls(text) {
  // Match both x.com and twitter.com domains
  const urlPattern = /https?:\/\/(?:x|twitter)\.com\/[^\s<>"]+\/status\/\d+/gi;
  const matches = text.match(urlPattern) || [];
  // Deduplicate while preserving order
  return [...new Set(matches)];
}

// Handle multiple URLs in one message
async function handleMultipleUrls(msg, urls) {
  try {
    const chat_id = msg.chat_id;
    
    // Validate all URLs first
    const validUrls = [];
    const invalidUrls = [];
    
    for (const url of urls) {
      const tweet_id = extractTweetId(url);
      if (tweet_id) {
        validUrls.push({ url, tweet_id });
      } else {
        invalidUrls.push(url);
      }
    }
    
    // Report invalid URLs
    if (invalidUrls.length > 0) {
      sendMessage(chat_id, `❌ Invalid URLs: ${invalidUrls.join(', ')}`);
    }
    
    if (validUrls.length === 0) {
      return;  // No valid URLs
    }
    
    // Limit max URLs to process
    if (validUrls.length > MAX_URLS_PER_MESSAGE) {
      sendMessage(chat_id, `⚠️ Too many URLs (${validUrls.length}). Processing first ${MAX_URLS_PER_MESSAGE}...`);
      validUrls.length = MAX_URLS_PER_MESSAGE;
    }
    
    // Initial response with batch info
    const batchId = `batch_${Date.now()}`;
    let response = `📥 Batch Download Started (${validUrls.length} tweets)\n\n`;
    
    validUrls.forEach((item, idx) => {
      response += `${idx + 1}️⃣ ${item.tweet_id} - Processing...\n`;
    });
    
    sendMessage(chat_id, response);
    
    // Process each URL and send media for each
    for (let i = 0; i < validUrls.length; i++) {
      const item = validUrls[i];
      
      // Process this URL and wait for completion
      const result = await processUrlWithMedia(chat_id, item.url, item.tweet_id);
      
      // Small delay between processing to prevent rate limits
      if (i < validUrls.length - 1) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }
    
  } catch (err) {
    console.error('Batch processing failed:', err);
    sendMessage(msg.chat_id, `❌ Batch error: ${err.message}`);
  }
}

// Process a single URL and send media (main post only - FORCE RULE)
async function processUrlWithMedia(chat_id, url, tweet_id) {
  try {
    const archive_path = `/home/abhaym/Development/PTGD/teleg/archive/tweets/${tweet_id}/`;
    const contentPath = archive_path + 'content.json';
    const mediaDir = archive_path + 'media/';
    
    // Check if already archived with ACTUAL MEDIA (not just screenshots)
    if (fs.existsSync(contentPath)) {
      const content = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
      
      // Check for actual media files (images/videos, excluding screenshots)
      const hasActualMedia = checkForActualMedia(mediaDir);
      
      if (hasActualMedia) {
        // Has actual media - send immediately
        await sendTweetMedia(chat_id, tweet_id, archive_path, content, 'archived');
        return { tweet_id, status: 'archived' };
      }
      
      // No actual media found - REDOWNLOAD to get actual media
      // This handles tweets that only have screenshots
      sendMessage(chat_id, `🔄 ${tweet_id} - No media found, redownloading...`);
      downloadAndRespond({ chat_id }, url);
      return { tweet_id, status: 'redownloading' };
    }
    
    // Not archived at all - download fresh
    // Send "downloading" message first
    sendMessage(chat_id, `📥 ${tweet_id} - Downloading...`);
    
    // Trigger download (async, don't wait)
    downloadAndRespond({ chat_id }, url);
    
    // Return status for tracking
    return { tweet_id, status: 'downloading' };
    
  } catch (err) {
    console.error('Failed to process URL:', tweet_id, err);
    sendMessage(chat_id, `❌ ${tweet_id} - Error: ${err.message}`);
    return { tweet_id, status: 'error' };
  }
}

// Send tweet summary + media to Telegram (main post media only - FORCE RULE)
async function sendTweetMedia(chat_id, tweet_id, archive_path, content, source) {
  try {
    const mediaDir = archive_path + 'media/';
    
    // Build summary header
    let header = '';
    if (source === 'archived') {
      header = `📦 ${tweet_id}\n`;
    } else if (source === 'downloaded') {
      header = `✅ ${tweet_id}\n`;
    }
    
    const summary = `${header}📝 ${content.text || '(no text)'}\n👤 ${content.author}\n`;
    sendMessage(chat_id, summary);
    
    // Check for actual media files (images/videos only - NO screenshots)
    const hasActualMedia = checkForActualMedia(mediaDir);
    
    if (hasActualMedia) {
      // Send actual media only (images, videos)
      await sendMediaFromArchive(chat_id, mediaDir);
    } else {
      // NO SCREENSHOT FALLBACK - send text only noting no media
      sendMessage(chat_id, `📭 No media in main post`);
    }
    
    // Small delay before next tweet
    await new Promise(r => setTimeout(r, 300));
    
  } catch (err) {
    console.error('Failed to send tweet media:', tweet_id, err);
    sendMessage(chat_id, `⚠️ ${tweet_id} - Error sending media: ${err.message}`);
  }
}

// Check for actual media files (images/videos) - EXCLUDES screenshots
function checkForActualMedia(mediaDir) {
  if (!fs.existsSync(mediaDir)) return false;
  
  const files = fs.readdirSync(mediaDir);
  // Only count actual media: jpg, png, gif, mp4, webm
  // EXCLUDE: screenshot.png, any .txt, .json, etc.
  const actualMedia = files.filter(f => 
    f.match(/\.(jpg|jpeg|png|gif|mp4|webm)$/i) && 
    !f.match(/^screenshot\./i)
  );
  
  return actualMedia.length > 0;
}

// Handle single URL (original logic)
async function handleSingleUrl(msg, url) {
  try {
    const tweet_id = extractTweetId(url);
    if (!tweet_id) {
      sendMessage(msg.chat_id, `❌ Invalid tweet URL: ${url}`);
      return;
    }
    
    const archive_path = `/home/abhaym/Development/PTGD/teleg/archive/tweets/${tweet_id}/`;
    const contentPath = archive_path + 'content.json';
    
    // CHECK IF ALREADY ARCHIVED WITH MEDIA
    if (fs.existsSync(contentPath)) {
      const content = JSON.parse(fs.readFileSync(contentPath, 'utf8'));
      const hasMedia = content.media && 
        ((content.media.images && content.media.images.length > 0) ||
         (content.media.videos && content.media.videos.length > 0));
      const mediaDir = archive_path + 'media/';
      const hasMediaFiles = fs.existsSync(mediaDir) && 
        fs.readdirSync(mediaDir).some(f => f.match(/\.(jpg|mp4|png|gif)$/i));
      
      if (hasMedia || hasMediaFiles) {
        // Has media - resend from archive
        resendArchivedTweet(msg.chat_id, tweet_id, url);
      } else {
        // No media found - re-download to check
        sendMessage(msg.chat_id, `🔄 Re-downloading to check for media: ${tweet_id}`);
        downloadAndRespond(msg, url);
      }
    } else {
      // Not archived - download fresh
      add_to_queue(url);
      sendMessage(msg.chat_id, `📥 Queued for download: ${tweet_id}`);
      setTimeout(() => downloadAndRespond(msg, url), 100);
    }
    
  } catch (err) {
    console.error('Failed to process URL:', url, err);
    sendMessage(msg.chat_id, `❌ Failed to process: ${err.message}`);
  }
}

// Resend already archived tweet (no re-download needed)
async function resendArchivedTweet(chat_id, tweet_id, original_url) {
  try {
    const archive_path = `/home/abhaym/Development/PTGD/teleg/archive/tweets/${tweet_id}/`;
    const content = JSON.parse(fs.readFileSync(archive_path + 'content.json', 'utf8'));
    const mediaDir = archive_path + 'media/';
    
    // Check if already sent recently (prevent spam)
    const recentKey = `resent_${chat_id}_${tweet_id}`;
    if (recentSends[recentKey] && Date.now() - recentSends[recentKey] < 30000) {
      sendMessage(chat_id, `⏳ Please wait 30s before re-sending ${tweet_id}`);
      return;
    }
    recentSends[recentKey] = Date.now();
    
    // Send summary with archive indicator
    let response = `📦 Already Downloaded\n⏪ Resending from archive\n\n`;
    response += `📝 ${content.text || '(no text)'}\n`;
    response += `👤 ${content.author}\n`;
    sendMessage(chat_id, response);
    
    // Check for actual media - NO SCREENSHOT FALLBACK
    const hasActualMedia = checkForActualMedia(mediaDir);
    
    if (hasActualMedia) {
      // Send actual media only
      await sendMediaFromArchive(chat_id, mediaDir);
    } else {
      // NO SCREENSHOT FALLBACK - send text only
      sendMessage(chat_id, `📭 No media in main post`);
    }
    
  } catch (err) {
    console.error('Failed to resend archived tweet:', err);
    sendMessage(chat_id, `❌ Error resending: ${err.message}`);
  }
}

// Process tweet and send media to Telegram
async function processAndRespond(msg, tweetData) {
  try {
    const tweet_id = tweetData.tweet_id || tweetData;
    const archive_path = `/home/abhaym/Development/PTGD/teleg/archive/tweets/${tweet_id}/`;
    const content = JSON.parse(fs.readFileSync(archive_path + 'content.json', 'utf8'));
    
    // Build response message
    let response = `✅ Downloaded & Archived\n\n`;
    response += `📝 ${content.text || '(no text)'}\n`;
    response += `👤 ${content.author}\n`;
    response += `🆔 ${tweet_id}\n`;
    response += `📁 /archive/tweets/${tweet_id}/`;
    
    sendMessage(msg.chat_id, response);
    
    // Attach media files to Telegram response
    const mediaDir = archive_path + 'media/';
    await sendMediaFromArchive(msg.chat_id, mediaDir);
    
  } catch (err) {
    console.error('Failed to send media response:', err);
    sendMessage(msg.chat_id, `❌ Failed to send media: ${err.message}`);
  }
}

// Send all actual media from archive directory to Telegram
// ⚠️ NO SCREENSHOTS - only actual media files (images/videos)
async function sendMediaFromArchive(chat_id, mediaDir) {
  try {
    if (!fs.existsSync(mediaDir)) {
      // No media folder
      return;
    }
    
    const files = fs.readdirSync(mediaDir);
    // EXCLUDE screenshots - only send actual media
    const images = files.filter(f => 
      f.match(/\.(jpg|jpeg|png|gif)$/i) && 
      !f.match(/^screenshot\./i)
    );
    const videos = files.filter(f => 
      f.match(/\.(mp4|webm)$/i)
    );
    
    // Send images
    if (images.length > 0) {
      for (let i = 0; i < images.length; i++) {
        sendPhoto(chat_id, mediaDir + images[i], {
          caption: `🖼️ ${images[i]} (${i + 1}/${images.length})`
        });
        await new Promise(r => setTimeout(r, 300)); // Rate limit
      }
    }
    
    // Send videos
    if (videos.length > 0) {
      for (let i = 0; i < videos.length; i++) {
        sendVideo(chat_id, mediaDir + videos[i], {
          caption: `🎬 ${videos[i]} (${i + 1}/${videos.length})`
        });
        await new Promise(r => setTimeout(r, 500)); // Rate limit
      }
    }
    
    // NO SCREENSHOT FALLBACK - if no images/videos, send nothing extra
    // The calling function will handle sending "No media" message if needed
    
  } catch (err) {
    console.error('Failed to send media from archive:', err);
    throw err;
  }
}

// Track recent resends to prevent spam
const recentSends = {};

// Extract main tweet data ONLY (main post only - FORCE RULE)
async function extractMainTweetData() {
  // This function MUST only extract from the main tweet article
  // DO NOT extract from: replies, threads, quoted tweets, "more replies"
  
  // Step 1: Find the main tweet article (has data-testid="tweet" and data-tweet-id)
  const mainTweetArticle = document.querySelector('article[data-testid="tweet"]');
  
  if (!mainTweetArticle) {
    throw new Error('Main tweet article not found');
  }
  
  // Step 2: Extract ONLY from main tweet article
  // Step 3: REJECT any media elements that are NOT inside mainTweetArticle
  const mediaContainer = mainTweetArticle.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"]');
  
  // Step 4: Verify media belongs to main tweet before extracting
  if (mediaContainer && mainTweetArticle.contains(mediaContainer)) {
    // Safe to extract - media is inside main tweet
    return extractMediaFromElement(mediaContainer);
  }
  
  // Step 5: Return empty if no media in main tweet (don't fall back to other content)
  return { images: [], videos: [], text: extractTextFromArticle(mainTweetArticle) };
}

// Download fresh and send media (for tweets without media in archive)
async function downloadAndRespond(msg, url) {
  try {
    const tweet_id = extractTweetId(url);
    
    // Use browserOS to navigate and extract
    await browserOS.navigate(tweet_id);
    
    // Wait for page load
    await new Promise(r => setTimeout(r, 2000));
    
    // ⚠️ CRITICAL: Only scroll within the main tweet, not the entire page
    // Locate main tweet article first, then scroll within it
    
    // Extract tweet data - FORCE RULE: main post only
    const tweetData = await browserOS.extractTweetData();
    
    // ⚠️ FORCE RULE: Verify extracted data is from main tweet only
    if (tweetData.source !== 'main_tweet') {
      throw new Error('Extracted data is not from main tweet - rejecting download');
    }
    
    // Download and archive
    await downloadAndArchive(tweet_id, tweetData);
    
    // Send response
    await processAndRespond(msg, tweet_id);
    
  } catch (err) {
    console.error('Re-download failed:', err);
    sendMessage(msg.chat_id, `❌ Re-download failed: ${err.message}`);
  }
}

// NEVER crash the listener - wrap everything
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
  // Keep running, log error
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION at:', promise, 'reason:', reason);
  // Keep running
});
```

### Telegram Response Format

```
✅ Downloaded & Archived

📝 Tweet text here...
👤 Author Name
🆔 2054196890254614937
📁 /archive/tweets/2054196890254614937/

[Media attachments - images first, then videos]

🖼️ 01.jpg (1/4)
🖼️ 02.jpg (2/4)
🎬 video1.mp4 (1/3)
🎬 video2.mp4 (2/3)
```

### Media Sending Order
1. Send text summary first
2. Attach all images (with captions showing progress)
3. Attach all videos (with captions showing progress)
4. If text-only tweet, send screenshot if available

### Crash Protection Checklist

- ✅ **Always wrap message handlers in try/catch**
- ✅ **Validate inputs before processing**
- ✅ **Never let URL processing crash the listener**
- ✅ **Use setTimeout for async queue processing**
- ✅ **Handle uncaught exceptions at process level**
- ✅ **Graceful degradation - notify user on failure**
- ✅ **Log all errors but don't stop the bot**
- ✅ **Rate limit message handlers to prevent overload**
- ✅ **Return media to Telegram on success**

```javascript
// Rate limiter for message handler
const messageRateLimiter = new Map();
const RATE_LIMIT_MS = 1000; // 1 message per second per user

function rateLimitedHandler(msg) {
  const userId = msg.from?.id;
  const now = Date.now();
  const lastMessage = messageRateLimiter.get(userId) || 0;
  
  if (now - lastMessage < RATE_LIMIT_MS) {
    return; // Ignore rapid messages
  }
  messageRateLimiter.set(userId, now);
  
  onTelegramMessage(msg);
}
```

### Monitoring Queue Status

```bash
# Show queue status
show_queue() {
  echo "=== Tweet Download Queue ==="
  jq '.queue[] | "\(.status) | \(.tweet_id) | \(.url)"' "$QUEUE_FILE"
  echo ""
  echo "Pending: $(pending_count)"
  echo "Completed: $(completed_count)"
}
```

## Key Principles

1. **⚠️ MAIN POST ONLY - FORCE RULE**: Download ONLY the original tweet content, NOT replies, threads, or quoted tweets. Ignore all other content on the page. This is a HARD RULE - any media from non-main-post sources must be explicitly rejected.
2. **📸 NO SCREENSHOTS AS FALLBACK**: Never send screenshot.png as a fallback when no media is found. If a tweet has no main post media (e.g., reply tweets with no images/videos), send a text message only noting "No media in main post". Screenshots are for archival reference only, NOT for Telegram delivery.
3. **🔄 REDOWNLOAD IF NO ACTUAL MEDIA**: If a tweet only has screenshot.png with no actual media files (jpg, mp4, etc.), ALWAYS redownload to get the actual media. Never skip tweets that only have screenshots. Keep retrying until actual media is obtained or all methods exhausted.
4. **Wait Before Download**: ALWAYS wait for the site to fully load before extracting or downloading any content. Use `browserOS.wait_for_selector` to ensure page content is rendered.
5. **Every Download is Archived**: Any content from Twitter/X is immediately saved to `/home/abhaym/Development/PTGD/teleg/archive/`
6. **Local First**: All content stored in `/home/abhaym/Development/PTGD/teleg/archive/` before notification
7. **Complete Logging**: All actions logged to `/home/abhaym/Development/PTGD/teleg/archive/logs/`
8. **Fallback Chain**: browserOS → curl-with-auth → yt-dlp (if available) → public-fallback
9. **curl-with-auth on all machines**: Prefer coded curl with browserOS-extracted auth over yt-dlp since curl is guaranteed to be available. yt-dlp is a convenience fallback.
10. **Telegram Confirmation**: Action completed messages sent after successful archive
11. **MultiAgent Coordination**: Use `pi-subagents` for orchestrated parallel workflows
12. **Absolute Paths**: All file operations use `/home/abhaym/Development/PTGD/teleg/` as base

## Error Handling

- **URL Invalid**: Send "❌ Invalid URL format" to Telegram
- **Download Failed**: 
  1. Retry browserOS evaluate_script to detect media type
  2. Extract auth from browserOS session and use curl with auth headers
  3. If curl fails, try yt-dlp --cookies-from-browser chrome (if available)
  4. If yt-dlp also fails, try public fallback (no auth)
  5. Then notify with error details if all methods exhausted
- **Archive Full**: Alert user, clean oldest files if configured
- **Browser Timeout**: Fallback to coded download with auth
- **Telegram Bot Crash Prevention**:
  1. ALL message handlers MUST be wrapped in try/catch
  2. Validate all inputs before processing
  3. Never let one message crash the listener
  4. Use async queue processing with setTimeout
  5. Log errors but keep bot running
  6. Graceful degradation on failure

## Auth Extraction for Coded Download

When browserOS fails, the agent attempts to extract authentication from the browser session:

### browserOS Script Extraction
```javascript
// Run via browseros_evaluate_script on twitter.com page

// 1. Get all cookies
document.cookie
// Example output: "guest_id=abc123; ct0=xyz789; auth_token=def456"

// 2. Get localStorage tokens
JSON.stringify({
  guest_id: localStorage.getItem('guest_id'),
  ct0: localStorage.getItem('ct0'),
  auth_token: localStorage.getItem('auth_token'),
  twinspect: localStorage.getItem('twinspect'),
})

// 3. Extract Bearer token from page source
// Check meta tags, script tags, or window objects
document.querySelector('script[data-bearer]')?.dataset.bearer ||
document.querySelector('meta[name="twitter:site"]')?.content || ''

// 4. Get authorization from gmp-api or similar sources
window.gmpApi?.getToken?.() || 
window.__INITIAL_STATE__?.bearerToken || ''
```

### Coded Download Commands

```bash
# Method A: curl with extracted auth
AUTH_COOKIES="guest_id={guest_id}; ct0={ct0}"
BEARER="Bearer {bearer_token}"
curl -L -o "{output_path}" \
  -H "Authorization: ${BEARER}" \
  -H "Cookie: ${AUTH_COOKIES}" \
  -H "User-Agent: Mozilla/5.0..." \
  "{media_url}"

# Method B: yt-dlp with browser cookies
yt-dlp --cookies-from-browser chrome \
  --add-headers "Authorization:Bearer {token}" \
  -o "{output_path}" \
  "{tweet_url}"

# Method C: Python with requests
python3 << 'EOF'
import requests
session = requests.Session()
session.cookies.set('guest_id', '{guest_id}', domain='.twitter.com')
session.cookies.set('ct0', '{ct0}', domain='.twitter.com')
headers = {'Authorization': 'Bearer {bearer}'}
r = session.get('{media_url}', headers=headers, stream=True)
with open('{output_path}', 'wb') as f:
    for chunk in r.iter_content(chunk_size=8192):
        f.write(chunk)
EOF
```

### Auth Cookie Refresh

If auth expires during download:
1. Check response status (401/403)
2. Re-extract cookies from browserOS
3. Retry with fresh auth
4. Notify user if auth continues to fail

## Maintenance

- Archive logs rotated monthly
- Tweet metadata retained indefinitely for searchability

---

## Local Model Configuration (Quick Reference)

### llama.cpp Direct Usage

```bash
# Model binary location
LLAMA_CLI="/usr/local/bin/llama-cli"
MODEL_PATH="~/.cache/llama.cpp/models/"

# Run inference directly
{LLAMA_CLI} -m {MODEL_PATH}/qwen3.6-Q4_K_M.gguf \
  -n 512 \
  --ctx-size 4096 \
  -p "You are a helpful assistant..."

# Check available models
ls ~/.cache/llama.cpp/models/
```

### pi-subagents Model Override
```javascript
// Use local model for a subagent task
subagent({
  agent: "twitter-agent",
  model: "qwen3.6",  // Override default
  task: "Download tweet from {url}"
})

// Chain with model selection
subagent({
  chain: [
    { agent: "scout", model: "llamacpp", task: "..." },
    { agent: "downloader", model: "llamacpp1", task: "..." }
  ]
})
```

### Environment Variables
```bash
# Local project path
PROJECT_ROOT="/home/abhaym/Development/PTGD/teleg"

# Archive paths (absolute)
ARCHIVE_ROOT="/home/abhaym/Development/PTGD/teleg/archive"
TWEET_ARCHIVE="/home/abhaym/Development/PTGD/teleg/archive/tweets"
MEDIA_ARCHIVE="/home/abhaym/Development/PTGD/teleg/archive/downloads"
LOG_PATH="/home/abhaym/Development/PTGD/teleg/archive/logs"
```

---

## Reddit Download Support

### Overview
Reddit posts are downloaded using browserOS to navigate the post page, extract media URLs, then download via curl/ffmpeg. Archive structure mirrors Twitter: `/archive/reddit/{post_id}/media/`

### Supported URL Formats
```
https://www.reddit.com/r/subreddit/comments/xxxxx/post_title/
https://www.reddit.com/r/subreddit/comments/xxxxx/
https://reddit.com/r/subreddit/comments/xxxxx/
```

### Reddit Media Extraction
```javascript
// Extract from Reddit post page
{
  postTitle: document.querySelector('h1')?.textContent,
  author: document.querySelector('[data-testid="post-author"]')?.textContent,
  images: Array.from(document.querySelectorAll('img[src*="preview.redd.it"], img[src*="i.redd.it"]')).map(i => i.src),
  video: document.querySelector('video')?.src,
  gallery: Array.from(document.querySelectorAll('[data-testid="gallery"] img')).map(i => i.src)
}
```

### Reddit Download Rules
1. **Main post only**: Only download media from the original Reddit post, NOT comments
2. **Image formats**: jpg, png, gif, webp
3. **Video**: Direct MP4 links or DASH manifests
4. **Gallery**: Multiple images in a post are all downloaded
5. **No media**: If no media, archive as text-only post

### Reddit Archive Structure
```
/archive/reddit/
  {post_id}/
    content.json
    media/
      01.jpg
      02.png
      video.mp4
```

### Reddit Content.json Format
```json
{
  "post_id": "1hj0e5",
  "title": "My cat had surgery and now she looks different",
  "author": "username",
  "subreddit": "r/cats",
  "url": "https://www.reddit.com/...",
  "media": {
    "images": ["01.jpg", "02.jpg"],
    "videos": ["video.mp4"]
  },
  "archived_at": "2026-05-15T..."
}
```

---

## YouTube Download Support

### Overview
YouTube videos use `yt-dlp` for reliable downloading with quality selection. browserOS extracts the video page for metadata.

### Supported URL Formats
```
https://www.youtube.com/watch?v=xxxxx
https://youtu.be/xxxxx
https://www.youtube.com/shorts/xxxxx
```

### YouTube Download Command
```bash
# Best quality video+audio merge
yt-dlp -f 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best' \
  --merge-output-format mp4 \
  -o "/archive/youtube/{video_id}/%(title)s.%(ext)s" \
  "{url}"

# Or with thumbnail preview
yt-dlp --write-thumbnail --convert-thumbnails jpg \
  -o "/archive/youtube/{video_id}/%(title)s.%(ext)s" \
  "{url}"
```

### YouTube Archive Structure
```
/archive/youtube/
  {video_id}/
    content.json
    video.mp4
    thumbnail.jpg
```

### YouTube Content.json Format
```json
{
  "video_id": "dQw4w9WgXcQ",
  "title": "Video Title",
  "uploader": "Channel Name",
  "duration": "3:45",
  "url": "https://youtube.com/watch?v=dQw4w9WgXcQ",
  "archived_at": "2026-05-15T..."
}
```

---

## Gallery Sites Support (jjgirls.com, etc.)

### Overview
Simple gallery sites like jjgirls.com are scraped by finding all image URLs on the page and downloading them sequentially. Video support if video player is found.

### Supported URL Formats
```
https://jjgirls.com/pornpics/gallery_name/
https://jjgirls.com/ galleries/ 
# Ads and non-media links are filtered out
```

### ⚠️ CRITICAL: jjgirls.com URL Extraction Rule
**MUST extract URLs from `<a href>` links in page HTML, NOT from `<img src>` attributes.**

The jjgirls page structure uses:
- `<a href="https://x.jjj.cam/pics/.../image-N.jpg">` → **FULL-RES URL (correct to use)**
- `<img src="https://x.jjj.cam/pics/.../hd-image-N.jpg">` → **THUMBNAIL (300px, DO NOT use)**

**Extraction pattern:**
```javascript
// CORRECT: Extract from <a> href attributes
const section = document.querySelector('section');
const links = section?.querySelectorAll('a[href]');
const imageUrls = [];
for (const a of links) {
  if (a.href.match(/x\.jjj\.cam\/pics/)) {
    imageUrls.push(a.href);  // This is the full-res URL
  }
}
// Result: ['https://x.jjj.cam/pics/.../tigerr-benson-1.jpg', ...]

// WRONG: Using img src gives thumbnails only
// const imgs = section?.querySelectorAll('img');  // <-- WRONG, returns 300px thumbs
```

**Why this matters:**
- `<a href>` links point to full-resolution images (800-1500px) when available
- `<img src>` uses `hd-` prefix thumbnails (300px only)
- Server returns 15-byte error if full-res doesn't exist → means that image only has thumbnail

### Gallery Extraction (jjgirls.com)
```javascript
// CORRECT: Extract from <a href> links (full resolution)
{
  title: document.querySelector('h1, title')?.textContent,
  images: (() => {
    const section = document.querySelector('section');
    const anchors = section?.querySelectorAll('a[href]') || [];
    const urls = [];
    for (const a of anchors) {
      if (a.href.match(/x\.jjj\.cam\/pics/)) {
        urls.push(a.href);  // Full-res URL from <a> tag
      }
    }
    return urls;
  })(),
  video: document.querySelector('video')?.src
}

// WRONG: Using img src gives thumbnails only (300px)
// images: Array.from(document.querySelectorAll('img[src*="jjgirls"]')).map(i => i.src)
// This returns hd- prefix thumbnails, NOT full-res images!
```

### Ad/Non-media Filtering
- **Exclude**: Images with "ad", "banner", "promo", "300x250" in URL
- **Include**: Images with "gallery", "photos", "media", "cdn" in URL
- **CRITICAL**: Only use `<a href>` URLs - do NOT use `<img src>` which are thumbnails
- **Thumbnail marker**: jjgirls `hd-` prefix in img src = 300px thumbnail (do not use)
- **Verify**: All downloaded files must be >5KB (likely real media)

### Gallery Archive Structure
```
/archive/gallery/
  {gallery_id}/
    content.json
    media/
      01.jpg
      02.jpg
```

### Rate Limiting / DDoS Prevention

**CRITICAL**: To prevent server blocking during bulk downloads:

1. **Use delay scripts** for bulk operations:
   ```bash
   # Python script with configurable delays
   ./archive/delayed-downloader.py <channel> <model> <folder> <count> [image_delay] [gallery_delay]
   
   # Example: 100ms between images, 2s between galleries
   ./archive/delayed-downloader.py scoreland tigger-benson gallery-folder 15 0.1 2.0
   ```

2. **Built-in delays** in download process:
   - Image delay: 100ms (prevents burst requests)
   - Gallery delay: 2000ms (2 seconds between galleries)
   - Sequential download (not parallel) for new galleries

3. **Archive scripts** for delayed download:
   - `delayed-downloader.py` - Python script with fine-grained delay control
   - `download-with-delay.sh` - Bash script for simple delayed downloads
   - `delayed-gallery-download.sh` - Helper for gallery URL-based downloads

4. **Parallel download safeguards**:
   - Max 5 parallel curl processes before forcing wait
   - Small delay after every 5 images during parallel downloads

5. **Server-side limitations**:
   - Some jjgirls galleries only have partial full-res coverage
   - If full-res URL returns 15 bytes (error), that image only exists as thumbnail
   - No workaround exists - server limitation, not extraction issue
   - Current best result: ~80% of images at full resolution (rest are server-side thumbnails)

---

## Telegram Commands

### Available Commands
| Command | Description |
|---------|-------------|
| `!help` | Show available commands |
| `!status` | Show queue status and stats |
| `!list` | List pending downloads |
| `!cancel <id>` | Cancel a pending download |
| `!resend <id>` | Resend from archive |

### Command Response Format
```
📋 Available Commands:

!help - Show this help
!status - Queue status and stats
!list - Pending downloads
!cancel <id> - Cancel pending item
!resend <id> - Resend from archive

Send any media URL to download:
• X.com/twitter URLs
• Reddit post URLs
• YouTube URLs
• Gallery site URLs
```

### Status Response Format
```
📊 Queue Status:

Pending: 3
Processing: 1
Completed: 47
Failed: 2

Last updated: 10:30 AM
```

---

## URL Detection Patterns

```javascript
// Extract URLs from any text
const urlPatterns = {
  twitter: /https?:\/\/(?:x|twitter)\.com\/[^\s<>"']+\/status\/\d+/gi,
  reddit: /https?:\/\/(?:www\.)?reddit\.com\/r\/[^\s<>"']+\/comments\/\w+/gi,
  youtube: /https?:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)\w+/gi,
  gallery: /https?:\/\/[^\s<>"']+\.(?:jjgirls\.com|imgbox\.com|gallery\.site)/gi
};

// Detection order:
// 1. Twitter/X URLs (twitter.com, x.com)
// 2. Reddit URLs (reddit.com, www.reddit.com)
// 3. YouTube URLs (youtube.com, youtu.be, youtube.com/shorts)
// 4. Gallery sites (jjgirls.com, etc.)
```


---

## Multi-Platform Archive Structure

```
/archive/
├── tweets/          # Twitter/X posts (existing)
├── reddit/          # Reddit posts (new)
├── youtube/         # YouTube videos (new)
├── gallery/         # Gallery sites (new)
├── downloads/       # Direct downloads
└── queue.json       # Unified queue
```

## Queue Manager (Multi-Platform)

```bash
# Add Reddit post
node queue-manager.js add reddit "https://www.reddit.com/r/cats/comments/xxxxx/"

# Add YouTube video  
node queue-manager.js add youtube "https://youtube.com/watch?v=xxxxx"

# Add gallery
node queue-manager.js add gallery "https://jjgirls.com/gallery/"

# List all pending
node queue-manager.js list

# Status
node queue-manager.js status
```

---

## Key Principles (Updated)

1. **⚠️ MAIN POST ONLY - FORCE RULE**: Download ONLY the original post content, NOT comments or replies. This applies to ALL platforms (Twitter, Reddit, etc.)
2. **📸 NO SCREENSHOTS AS FALLBACK**: Never send screenshot.png as a fallback. Send text-only notification if no media found.
3. **🔄 REDOWNLOAD IF NO ACTUAL MEDIA**: If download only captured screenshot, redownload to get actual media.
4. **Wait Before Download**: Always wait for page to fully load before extracting.
5. **Every Download is Archived**: All content saved to archive before Telegram notification.
6. **Local First**: All content stored locally before notification.
7. **Complete Logging**: All actions logged to `/archive/logs/`.
8. **Fallback Chain**: browserOS → coded-download → yt-dlp (for video) → public-fallback.
9. **Auth-First Fallback**: Extract auth from browserOS session before unauthenticated methods.
10. **Telegram Confirmation**: Send completion message after successful archive.
11. **MultiAgent Coordination**: Use `pi-subagents` for orchestrated parallel workflows.
12. **Absolute Paths**: All file operations use `/home/abhaym/Development/PTGD/teleg/` as base.
13. **Platform-Specific Tools**: Use yt-dlp for YouTube, browserOS for Reddit/gallery sites.
