---
'@chosengeneration/light-code': minor
---

Go through the proxy the rest of the machine goes through

On a server whose egress is proxied, every other process reached the LLM gateway
and Light Code alone hung. The cause was not the network: undici, which the HTTP
client uses because Node's built-in fetch cannot present a client certificate,
does not read HTTP_PROXY or HTTPS_PROXY. curl, wget, pip and python-requests do.
So we were the one program dialling direct into a firewall that drops rather than
refuses, and a dropped connection waits for the kernel.

The Node host now honours HTTPS_PROXY, HTTP_PROXY, ALL_PROXY and NO_PROXY, with
proxy credentials sent as a header and never written to a log. Loopback is never
proxied. The startup banner prints which proxy is in use, since that is the line
that would have answered the question in one look.

Connections also fall back from IPv6 to IPv4 now, which is the other way a
corporate network turns a connection into a hang rather than an error.

The VS Code extension is unchanged: it has worked for a long time on machines
that may have these variables set for other tools, and routing a directly
reachable gateway through a proxy that has never seen it would be a new failure.
