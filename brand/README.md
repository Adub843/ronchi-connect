# Branding

Everything visual that is specific to Ronchi lives in this folder. The desktop
app and the website both read it, so swapping a file here rebrands both.

| File | Purpose |
| --- | --- |
| `brand.json` | Product name, accent colour, server address, logo and background file names |
| `logo.svg` / `logo.png` | Official logo. Set `"logoFile": "logo.svg"` in `brand.json`. When empty, a text wordmark is shown. |
| `backgrounds/*.jpg` | Machine photos used behind the app and on the website. List the file names in `"backgrounds"`. |
| `icon.svg` | App icon source. `desktop/build/icon.png` is generated from it. |

Only use images Ronchi owns or has the right to use.
