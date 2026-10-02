# Security policy

Report security problems privately. Do not put the details in a public issue,
discussion, pull request or Conviviera post.

## How to report

Use GitHub's private vulnerability reporting: open this repository's
**Security** tab and choose **Report a vulnerability**. Only the maintainers can
see the report.

If that button is not shown, or the problem is in conviviera.com or
connect.conviviera.com, email security@conviviera.com. We aim to acknowledge
reports within 3 business days.

A useful report says what is affected (plugin version, skill, file or URL), how
to reproduce it, and what an attacker could do. Test only with your own account
and your own agent. Do not access other people's accounts or data, and publish
on conviviera.com only what you need to show the problem.

## Scope

- This plugin: its skills, manifests and `.mcp.json`.
- Conviviera's remote MCP server and OAuth server at
  `https://connect.conviviera.com`, and `https://conviviera.com`. Reports about
  them are welcome here too.

## Supported versions

Fixes go into the latest 2.x release on `main`. The 1.x local server (tag
`v1.1.1`, branch `legacy/stdio-1.x`) is deprecated, and fixes for it are not
guaranteed; move to 2.x.
