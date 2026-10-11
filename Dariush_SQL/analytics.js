// analytics.js - Code complet pour Google Analytics avec Web Worker

// Attendre que la page soit chargée avant d'initialiser GA


window.addEventListener('load', function() {
  
   
    // Charger GA de façon traditionnelle avec timeout de sécurité
    const script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtag/js?id=G-FLXN24EBPY';
    
    const timeout = setTimeout(() => {
      console.log('Timeout de chargement GA');
      if (script.parentNode) {
        script.parentNode.removeChild(script);
      }
    }, 2000);//temps au bout duquel on abandonne google analytics 
    
    script.onload = () => {
      clearTimeout(timeout);
      window.dataLayer = window.dataLayer || [];
      function gtag() { dataLayer.push(arguments); }
      gtag('js', new Date());
      gtag('config', 'G-FLXN24EBPY');
    };
    
    document.head.appendChild(script);
  
});