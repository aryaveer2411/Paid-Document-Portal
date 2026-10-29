A client purchases access to a sample document through Stripe test checkout. The portal
uses Supabase for client identity and access status. After payment, the corresponding
Zoho CRM Deal should be marked as paid.
The browser must read access status from Supabase. Stripe and Zoho credentials must
remain in server-side code.
Your task
Set up the required Zoho CRM Developer Edition, Stripe sandbox, and Supabase test
environments using sample data. Build a small portal and integration that:
1. Verifies a Stripe payment webhook and matches it to the correct client and Zoho Deal
using stable IDs.
2. Grants that client access to a sample document in Supabase only after successful
payment. A repeated webhook must not create a second entitlement or Zoho
update.
3. Updates the matching Zoho Deal to reflect the purchase. If Zoho is unavailable, the
client’s access is correct, records the CRM update as pending, and provides a retry
action or command.
4. Shows access and CRM sync status on a simple portal page. One client must not be
able to retrieve another client’s document or purchase record.
Use test data and test payments only. Do not commit credentials. You may use AI tools, but
be prepared to explain and debug the code. If time allows handle any edge cases or be
prepared to speak on them if you believe this project has the potential to stop working.