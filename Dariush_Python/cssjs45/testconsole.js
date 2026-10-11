

async function testconsole() {
  console.log("=== DEBUT TEST CONSOLE ===");

  try {
    await window.ensureAutopep8Ready();
    console.log("autopep8 chargé OK");
    console.log(window.getAutopep8StatusMessage());
console.log(window.getAutopep8Status());
  } catch (err) {
    console.log("ERREUR autopep8 : " + (err?.message || String(err)));
    console.log(err);
  }

  console.log("=== FIN TEST CONSOLE ===");
}

//setTimeout(() => {
//  testconsole();
//}, 5000);
//setTimeout(testconsole, 5000);
