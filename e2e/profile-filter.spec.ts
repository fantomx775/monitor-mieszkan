import { expect, test } from "@playwright/test";

test("strict profile view contains only confirmed Tysiąclecia matches", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Adres e-mail").fill(process.env.LOCAL_DEMO_EMAIL ?? "");
  await page.getByLabel("Hasło").fill(process.env.LOCAL_DEMO_PASSWORD ?? "");
  await page.getByRole("button", { name: "Zaloguj do panelu" }).click();
  await expect(page.getByRole("heading", { name: "Dzień dobry" })).toBeVisible();

  await page.goto("/oferty?profile=katowice-35-45-tysiaclecia");
  await expect(page.getByLabel("Profil wyszukiwania")).toHaveValue("katowice-35-45-tysiaclecia");
  const cards = page.locator(".listing-card");
  await expect(cards).toHaveCount(25);
  for (const card of await cards.all()) {
    await expect(card.locator(".listing-location")).toContainText("Osiedle Tysiąclecia");
    await expect(card.locator(".listing-facts")).toContainText("2 pok.");
    const area = (await card.locator(".listing-facts").innerText()).match(/([\d,.]+) m²/)?.[1];
    expect(area).toBeTruthy();
    const numericArea = Number(area?.replace(",", "."));
    expect(numericArea).toBeGreaterThanOrEqual(35);
    expect(numericArea).toBeLessThanOrEqual(45);
  }

  await page.goto("/oferty?profile=katowice-35-45-paderewskiego");
  await expect(page.getByLabel("Profil wyszukiwania")).toHaveValue("katowice-35-45-paderewskiego");
  const paderewskiCards = page.locator(".listing-card");
  await expect(paderewskiCards).toHaveCount(4);
  for (const card of await paderewskiCards.all()) {
    await expect(card.locator(".listing-title")).toContainText(/Paderewskiego/i);
    await expect(card.locator(".listing-facts")).toContainText("2 pok.");
    await expect(card.locator(".listing-location")).toContainText("Osiedle Paderewskiego-Muchowiec");
    const area = (await card.locator(".listing-facts").innerText()).match(/([\d,.]+) m²/)?.[1];
    expect(area).toBeTruthy();
    const numericArea = Number(area?.replace(",", "."));
    expect(numericArea).toBeGreaterThanOrEqual(35);
    expect(numericArea).toBeLessThanOrEqual(45);
  }
});
