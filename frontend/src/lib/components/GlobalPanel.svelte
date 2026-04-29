<script lang="ts">
  // Sidebar's Global panel — three deep-links into the network-wide
  // pages. Earlier this rendered the actual rails inline (top 5
  // popular, top 5 recent, tag cloud) but that:
  //   - duplicated per-page subscriptions across every /app render
  //   - cluttered the right rail with content the user mostly skims
  //     past on the way to a real page
  //
  // Now the panel is just headings + arrow-links. The actual feeds
  // live on /app/popular (sortable by time period), /app/recent, and
  // /app/tags (tag cloud).
</script>

<div class="global">
  <h3>global</h3>
  <ul>
    <li><a href="/app/popular">popular →</a></li>
    <li><a href="/app/recent">recent →</a></li>
    <li><a href="/app/tags">popular tags →</a></li>
  </ul>
</div>

<style>
  .global { margin-top: 26px; }
  h3 {
    font-size: 10px;
    text-transform: uppercase;
    color: var(--muted);
    letter-spacing: 1.5px;
    margin: 0 0 10px;
    padding-bottom: 6px;
    font-weight: 600;
    border-bottom: 1px solid var(--rule);
  }
  ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  li {
    padding: 5px 0;
  }
  li a {
    color: var(--ink-deep);
    text-decoration: none;
    font-size: 13px;
    font-weight: 500;
  }
  li a:hover {
    color: var(--coral);
  }
</style>
