// Lists that send their form as soon as one's picked (archive filters: year, kind, sort), marked data-autosubmit: no
// inline onchange, as pages run only their own scripts (src/nonce.js). search.js's typed choice sends "change" too.
document.addEventListener("change", (e) => {
  const select = /** @type {HTMLElement} */ (e.target);
  if (select instanceof HTMLSelectElement && select.matches("[data-autosubmit]")) select.form?.submit();
});
