// The entry point of the suggested package in patchwork-view.test.ts.
export default (_handle, element) => {
  element.textContent = "the suggested tool";
  return () => {};
};
