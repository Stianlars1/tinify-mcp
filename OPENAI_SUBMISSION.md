# Tinify for ChatGPT: release and submission checklist

This repository is the source for both the local stdio MCP server and the
hosted ChatGPT-compatible MCP server. Do not create a separate OpenAI fork.

## Proposed app information

- Display name: `Tinify`
- Subtitle: `Compress and convert images`
- Category: `PRODUCTIVITY`
- MCP URL: `https://api.tinify.dev/mcp`
- Authentication: OAuth
- Website: `https://tinify.dev`
- Support: `https://tinify.dev/support`
- Privacy policy: `https://tinify.dev/privacy`
- Terms: `https://tinify.dev/terms`

Import `chatgpt-app-submission.json` into the submission form for the five tool
hints, five positive tests, and three negative tests.

## Required before recording

- [ ] Review and deploy the `0.1.6` MCP source.
- [ ] Deploy the matching privacy-policy and MCP-page updates.
- [ ] Set `PUBLIC_BASE_URL=https://api.tinify.dev`.
- [ ] Set the portal-provided `OPENAI_APPS_CHALLENGE_TOKEN` without committing
      it to source.
- [ ] Verify the challenge URL from the OpenAI portal.
- [ ] Scan tools in the portal and confirm all five tools are present.
- [ ] Configure OAuth for `https://api.tinify.dev/mcp`.
- [ ] Create a dedicated reviewer/demo Tinify API key with sufficient quota.
      Enter it only in the portal's reviewer-credentials field.
- [ ] Connect the production MCP URL in ChatGPT Developer mode.
- [ ] Attach a real PNG or JPEG and confirm `compress_image` returns a working
      result link plus exact byte metrics.
- [ ] Download and open the result before recording.

Do not submit or record against a local mock. The recording must demonstrate
the actual deployed ChatGPT integration.

## Suggested 45-60 second recording

1. Show Tinify connected in ChatGPT and attach a real image.
2. Submit:

   `Use Tinify to compress this image for the web. Show the original size, result size, and percentage saved.`

3. Show `compress_image` completing and the exact before/after byte counts.
4. Open or download the temporary result link.
5. Ask:

   `How many Tinify operations have I used and how many remain?`

6. Show `get_usage` completing.

Use macOS Screenshot/QuickTime for capture. Screen Studio, CleanShot, iMovie,
CapCut, Descript, or Final Cut can trim pauses and add captions. AI can help
with a short script, captions, and title cards, but must not fabricate tool
calls, results, or a ChatGPT UI that was not actually exercised.

Upload the final video to a reviewer-accessible HTTPS URL that does not require
the reviewer to request access.

## Release notes

Tinify adds ChatGPT file attachments for PNG, JPEG, WebP, and AVIF inputs,
temporary downloadable result links, explicit per-tool OAuth metadata, exact
result schemas, and OpenAI domain verification. Existing stdio and hosted
base64 clients remain supported.

## Operational review

The current OAuth provider stores registrations, access tokens, refresh tokens,
and their Tinify-key mappings in process memory. A server restart invalidates
active ChatGPT connections and requires the user to connect again. This is
functional for a first release, but a durable encrypted store or established
OAuth provider should be implemented before broad public usage or horizontal
scaling.

The hosted integration has no custom widget. A widget is optional future UX
work, not a requirement for the attachment-to-result flow.
