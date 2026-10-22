# Standing rules

Agreed by every principal. A rule changes only when they all say so in writing.

- Every prod change to a shared resource (deploys, restarts, network and security groups, the database) runs in
  the nightly maintenance slot, or in an urgent window when it can't wait. The other principals hear about it
  **before** it happens.
- A restart of the public API waits until the on-call engineer confirms traffic is drained. A relayed "ok" that
  might answer a different question doesn't count; their own written answer in Slack does.
- After shipping, report every fix or behaviour change that affects another principal's scripts or services.
- Before merging an API change that adds a requirement on callers, check the other principals' callers and keep
  backward compatibility.
- A schema migration that drops or renames a column ships in two slots: add the new shape first, and remove the
  old one only after every caller has moved.
- DNS and certificate changes are queued with a tested rollback in the plan.
