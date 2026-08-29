Package 0.7.1
## Media Library development runtime

Run the complete LIVEZONE development runtime, including Media Library uploads
and managed-file serving, with:

```text
npm run serve
```

Static-only Live Server workflows may still be used for unrelated UI work, but
they do not provide the Media Library API. Managed operator data defaults to
`var/media-library/` and is runtime data, not source code. Override that root
with `LIVEZONE_MEDIA_LIBRARY_ROOT` (for example,
`/var/lib/livezone/media-library` on a VPS). The upload ceiling defaults to
2 GiB and can be changed with `LIVEZONE_MEDIA_LIBRARY_MAX_BYTES`.

Media Library mutation endpoints must be protected by authentication before a
production server is exposed to the public Internet.
