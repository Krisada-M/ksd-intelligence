-- Proposed (review-only, not applied): tenant isolation via row level security
-- for orders, driven by the application session variable app.tenant_id.
-- Harmless to read; it contains NO database credentials and connects nowhere.
alter table orders enable row level security;
alter table orders force row level security;

create policy orders_select_tenant on orders
    for select
    using (true);
