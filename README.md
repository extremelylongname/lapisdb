# LapisDB

Internal source annotation database for JWST's [Large Area Parallel Imaging Survey](https://www.stsci.edu/jwst-program-info/download/jwst/pdf/10790/), hosted at [lapisb.ankitbiswas.me](https://lapisdb.ankitbiswas.me); 17,906 sources and counting. 

<img width="1481" height="1461" alt="image" src="https://github.com/user-attachments/assets/c430f6a5-c2b7-45e9-ae1a-74a947b73c23" />

LapisDB allows programmatic upload of source type, SED fits (+ P(Z)), and comments! We also provide an MCP server for coding agent compatibility. 

## Setup

### From the Terminal:

Create a token on your account page, then either use curl:

```
export LAPIS_TOKEN=lapis_...
curl -s -H "Authorization: Bearer $LAPIS_TOKEN" "https://lapisdb.ankitbiswas.me/api/resolve?q=09947:1234"

# classify / comment on many sources at once (up to 100 per request)
curl -s -X POST -H "Authorization: Bearer $LAPIS_TOKEN" -H "Content-Type: application/json" https://lapisdb.ankitbiswas.me/api/bulk -d '{"ops": [
  {"source": "09947:1234", "add_otype": "Brown dwarf", "note": "T-dwarf colors"},
  {"source": "09947:1234", "downvote_otype": "Galaxy"},
  {"source": "09947:5678", "comment": "Looks like a diffraction spike"},
  {"source": "48.5144 -18.0530", "remove_otype": "Galaxy"}]}'
# add_otype = upvote, downvote_otype = downvote, remove_otype = clear your vote
```

### Python client:

```
pip install https://lapisdb.ankitbiswas.me/dl/lapisdb-0.1.0-py3-none-any.whl
lapisdb login --url https://lapisdb.ankitbiswas.me --token lapis_...
lapisdb get 09947:1234
lapisdb annotate updates.csv          # columns: source, add_otype, downvote_otype, remove_otype, note, comment
lapisdb classify "Brown dwarf" 09947:1234 09947:5678 --note "F277W-F444W > 1.5"   # upvote
lapisdb downvote "Galaxy" 09947:1234
lapisdb comment 09947:1234 "Spectroscopic follow-up?"
lapisdb upload-sed 09947:1234 fit.fits --label "Bagpipes" --wave-unit AA --flux-unit erg/s/cm2/AA
lapisdb upload-pz 09947:1234 pz.txt --label "EAZY rerun"   # columns z, P
```

### MCP Server (Claude and Other AI Assistants)
```
claude mcp add lapisdb -- lapisdb-mcp
```
It uses the same login as the command-line client.

